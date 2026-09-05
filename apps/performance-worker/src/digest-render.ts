// Weekly greeter digest — the rendering half.
//
// Takes the blocks digest.ts built and turns them into a subject line, an HTML
// body and a plain-text body. It reads; it does not fetch, and it does not
// decide anything about the week. That separation is what lets the preview route
// render a real week without a queue row existing.
//
// INLINE `style=` ONLY, NEVER A <style> BLOCK. Outlook renders mail through
// Word's HTML engine, which discards embedded stylesheets entirely; a rule that
// looks fine in Gmail vanishes for roughly half the people this goes to. Same
// reason every layout here is a table: Word ignores flex and grid outright.
//
// 536px IS THE WHOLE BUDGET. wrapInEmailShell gives a 600px container with
// 32px/28px padding, so any table wider than 536 is either clipped or forces a
// horizontal scrollbar on mobile. The day table below is five columns for that
// reason and not because five is a natural number of things to show.
//
// COLOUR IS NEVER THE ONLY SIGNAL. Under-goal cells go amber, but they also
// carry a signed "-1.9 vs 25.0%" line, because a meaningful share of readers
// open this in a client that strips background colours and because some of them
// are colour-blind. If a fact is only expressed as a colour, it is not expressed.

import { escapeAttr, escapeHtml, wrapInEmailShell } from "@splash/email-shell";
import { delta } from "@splash/greeter-metrics";
import type { GreeterPeriodReportRow } from "@splash/types/greeter";

import type { DigestDay, DigestSiteBlock, DigestWeek } from "./digest.js";

/* ============================================================
 * Palette — the house tokens, copied rather than imported
 *
 * @splash/email-shell exports the shell, not its colours. Duplicating six hex
 * strings is the lesser evil against widening that package's surface for one
 * consumer; if a third sender needs them they should move together.
 * ============================================================ */

const NAVY = "#0E2745";
const INK = "#1F2937";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const AMBER = "#B45309";
const AMBER_BAR = "#F59E0B";
const AMBER_BG = "#FFFBEB";

export interface RenderedDigest {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

/* ============================================================
 * Entry point
 * ============================================================ */

/**
 * Render one recipient's digest.
 *
 * `blocks` is that person's slice, already ordered — sliceForRecipient decides
 * which sites appear and in what order, and this function does not second-guess
 * it. An empty slice never reaches here: listGreeterDigestRecipients drops
 * anyone whose grants miss the enrolled set, because a digest listing zero sites
 * reads as "your sites reported nothing" rather than as "you have no sites".
 *
 * GROUPED ONLY WHEN THERE IS SOMETHING TO GROUP. With one site the body is a
 * day table and a greeter table, no section furniture — ten of the twelve
 * current recipients hold exactly one location, and a "Site 19" heading above
 * the only site in the mail is noise. With more than one, each site gets a
 * headed section and a summary table goes on top so the reader can find the
 * problem site before scrolling through nine healthy ones.
 */
export function renderGreeterDigest(
  blocks: DigestSiteBlock[],
  week: DigestWeek,
  reportUrl: string | null
): RenderedDigest {
  const range = rangeLabel(week);
  const grouped = blocks.length > 1;
  const missingTotal = blocks.reduce(
    (sum, b) => sum + b.days_missing_site.length,
    0
  );

  // The missing-day count goes in the subject because it is the one thing that
  // makes this mail worth opening on a Monday morning. "All days reported" is
  // stated positively rather than left off — a subject that only ever names
  // problems teaches people to read a plain subject as "nothing to see", and
  // then a delivery failure looks exactly like a clean week.
  const scope = grouped
    ? `${blocks.length} sites`
    : (blocks[0]?.location_code ?? "no sites");
  const flag =
    missingTotal > 0
      ? `${missingTotal} day${missingTotal === 1 ? "" : "s"} missing`
      : "all days reported";
  const subject = `Greeter weekly — ${scope} · ${range} — ${flag}`;

  const bodyHtml = wrapInEmailShell(
    renderBodyHtml(blocks, range, grouped, missingTotal, reportUrl),
    {
      title: subject,
      preheader: buildPreheader(blocks, missingTotal)
    }
  );

  return {
    subject,
    bodyHtml,
    bodyText: renderBodyText(blocks, range, missingTotal, reportUrl)
  };
}

/**
 * The inbox preview line. Names the worst thing first, since that is what the
 * reader is deciding on before they open anything.
 */
function buildPreheader(
  blocks: DigestSiteBlock[],
  missingTotal: number
): string {
  const parts: string[] = [];
  if (missingTotal > 0) {
    const sites = blocks.filter((b) => b.days_missing_site.length > 0).length;
    parts.push(
      `${missingTotal} day${missingTotal === 1 ? "" : "s"} with no submission across ${sites} site${
        sites === 1 ? "" : "s"
      }`
    );
  } else {
    parts.push("Every day reported");
  }
  const withCapture = blocks.filter((b) => b.totals?.capture_pct != null);
  if (withCapture.length > 0) {
    const best = withCapture.reduce((a, b) =>
      (b.totals?.capture_pct ?? 0) > (a.totals?.capture_pct ?? 0) ? b : a
    );
    parts.push(
      `top capture ${fmtPct(best.totals?.capture_pct ?? null)} at ${best.location_code}`
    );
  }
  return parts.join(" · ");
}

/* ============================================================
 * HTML body
 * ============================================================ */

function renderBodyHtml(
  blocks: DigestSiteBlock[],
  range: string,
  grouped: boolean,
  missingTotal: number,
  reportUrl: string | null
): string {
  const out: string[] = [];

  out.push(
    `<p style="margin: 0 0 4px 0; font-size: 20px; font-weight: 700; color: ${NAVY};">Greeter week — ${escapeHtml(range)}</p>`,
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${MUTED};">${escapeHtml(
      grouped
        ? `${blocks.length} sites you have access to`
        : (blocks[0]?.location_code ?? "")
    )}</p>`
  );

  if (missingTotal > 0) out.push(renderMissingCallout(blocks, missingTotal));

  if (grouped) out.push(renderSiteSummary(blocks));

  for (const block of blocks) {
    if (grouped) out.push(renderSiteHeading(block));
    out.push(renderDayTable(block));
    out.push(renderPriorNote(block));
    out.push(renderGreeterTable(block));
  }

  if (reportUrl) {
    out.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 26px 0 4px 0;"><tr><td>`,
      `<a href="${escapeAttr(reportUrl)}" style="display: inline-block; padding: 12px 24px; background-color: #1FB6E0; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 6px; border: 2px solid #1FB6E0; mso-padding-alt: 0;" target="_blank" rel="noopener">Open the full report</a>`,
      `</td></tr></table>`
    );
  }

  return out.join("\n");
}

/**
 * The days with no submission, named up front.
 *
 * A LIST OF DATES, NOT A COUNT. "3 days missing" tells a manager they have a
 * problem; "Tue 8/26, Wed 8/27, Sun 8/31" tells them which shifts to go ask
 * about, which is the only version anybody can act on before the next digest.
 *
 * Days where the crew logged but the site did not are called out separately in
 * the same block. That combination is the common one and it has a specific
 * meaning — the greeters did their part — so collapsing it into a plain
 * "missing" would send the manager to the wrong people.
 */
function renderMissingCallout(
  blocks: DigestSiteBlock[],
  missingTotal: number
): string {
  const rows: string[] = [];
  for (const block of blocks) {
    if (block.days_missing_site.length === 0) continue;
    const covered = block.days_missing_site.filter((d) => {
      const day = block.days.find((x) => x.business_date === d);
      return (day?.greeters_logged ?? 0) > 0;
    });
    const dates = block.days_missing_site.map(dayLabel).join(", ");
    const tail =
      covered.length > 0
        ? ` — greeters logged on ${covered.length === block.days_missing_site.length ? "all of these" : covered.map(dayLabel).join(", ")}, so only the site's own numbers are missing`
        : "";
    rows.push(
      `<tr><td style="padding: 8px 12px; font-size: 14px; line-height: 1.5; color: ${INK}; background-color: ${AMBER_BG}; border-left: 3px solid ${AMBER_BAR};">` +
        `<strong>${escapeHtml(block.location_code)}</strong>: ${escapeHtml(dates)}${escapeHtml(tail)}` +
        `</td></tr>` +
        `<tr><td style="height: 4px; line-height: 4px; font-size: 0;">&nbsp;</td></tr>`
    );
  }
  if (rows.length === 0) return "";
  return (
    `<p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; color: ${AMBER};">${missingTotal} day${
      missingTotal === 1 ? "" : "s"
    } with no site submission</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 8px 0;"><tbody>${rows.join(
      ""
    )}</tbody></table>`
  );
}

/**
 * One row per site, for readers who hold several.
 *
 * Ordered worst-capture-first rather than alphabetically. Andrew holds all ten;
 * an alphabetical list makes him read every row to find the one that moved,
 * whereas the thing he opened the mail for is at the top of this one. Sites with
 * no capture rate at all sort to the bottom — there is nothing to rank them on,
 * and a null is not a zero.
 */
function renderSiteSummary(blocks: DigestSiteBlock[]): string {
  const ordered = [...blocks].sort((a, b) => {
    const ac = a.totals?.capture_pct ?? null;
    const bc = b.totals?.capture_pct ?? null;
    if (ac === null && bc === null)
      return a.location_code.localeCompare(b.location_code);
    if (ac === null) return 1;
    if (bc === null) return -1;
    return ac - bc;
  });

  const body = ordered
    .map((b) => {
      const missing = b.days_missing_site.length;
      return (
        `<tr>` +
        td(escapeHtml(b.location_code), {
          align: "left",
          weight: 600,
          color: NAVY
        }) +
        td(fmtInt(b.totals?.wash_sales ?? null)) +
        td(goalCell(b.totals?.capture_pct ?? null, b.totals?.capture_goal_pct ?? null, "pct")) +
        td(goalCell(b.totals?.dob ?? null, b.totals?.dob_goal ?? null, "money")) +
        td(
          missing > 0
            ? `<span style="color: ${AMBER}; font-weight: 600;">${missing}</span>`
            : `<span style="color: ${MUTED};">0</span>`
        ) +
        `</tr>`
      );
    })
    .join("");

  return (
    sectionHeader("All sites — week") +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 8px 0;">` +
    `<thead><tr>` +
    th("Site", "left") +
    th("Washes") +
    th("Capture") +
    th("DOB") +
    th("Missing") +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

function renderSiteHeading(block: DigestSiteBlock): string {
  const num =
    block.site_number === null ? "" : `Site ${block.site_number} &nbsp;·&nbsp; `;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 30px 0 10px 0;"><tr>` +
    `<td style="padding: 8px 0 8px 12px; border-left: 4px solid ${NAVY}; font-size: 17px; font-weight: 700; color: ${NAVY};">${num}${escapeHtml(
      block.location_code
    )}</td>` +
    `</tr></table>`
  );
}

/**
 * The seven-day grid, one row per calendar day whether or not anything landed.
 *
 * A DAY WITH NO SUBMISSION STILL OCCUPIES A ROW. A table that simply omits
 * Thursday makes the reader compare dates to notice, and almost nobody does; the
 * absence has to be visible as an absence. That is also why the empty row says
 * what it says instead of showing dashes — em dashes down a row read as "zero",
 * which is a claim about the business rather than about the paperwork.
 *
 * The week total sits in the same table rather than in its own, so the reader's
 * eye stays on one set of column positions.
 */
function renderDayTable(block: DigestSiteBlock): string {
  const rows = block.days.map((d) => renderDayRow(d)).join("");

  const t = block.totals;
  const totalRow = t
    ? `<tr>` +
      td(`Week`, { align: "left", weight: 700, color: NAVY, top: true }) +
      td(fmtInt(t.wash_sales), { weight: 700, top: true }) +
      td(fmtInt(t.sign_ups), { weight: 700, top: true }) +
      td(goalCell(t.capture_pct, t.capture_goal_pct, "pct"), { top: true }) +
      td(goalCell(t.dob, t.dob_goal, "money"), { top: true }) +
      `</tr>`
    : `<tr><td colspan="5" style="padding: 10px 0; border-top: 2px solid ${RULE}; font-size: 13px; color: ${AMBER};">` +
      `No site submissions at all this week — there is no week total to show.` +
      `</td></tr>`;

  return (
    sectionHeader("By day vs goal") +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 6px 0;">` +
    `<thead><tr>` +
    th("Day", "left") +
    th("Washes") +
    th("Sign-ups") +
    th("Capture") +
    th("DOB") +
    `</tr></thead><tbody>${rows}${totalRow}</tbody></table>`
  );
}

function renderDayRow(d: DigestDay): string {
  if (d.row === null) {
    // The greeter count is carried into this row rather than dropped because it
    // is the difference between "nobody worked" and "the crew reported and the
    // manager didn't", and those go to two different people.
    const note =
      d.greeters_logged > 0
        ? `No site submission — ${d.greeters_logged} greeter${d.greeters_logged === 1 ? "" : "s"} logged`
        : `No submissions`;
    return (
      `<tr>` +
      `<td style="padding: 9px 8px 9px 10px; font-size: 13px; font-weight: 600; color: ${INK}; background-color: ${AMBER_BG}; border-left: 3px solid ${AMBER_BAR}; border-bottom: 1px solid ${RULE}; white-space: nowrap;">${escapeHtml(
        dayLabel(d.business_date)
      )}</td>` +
      `<td colspan="4" style="padding: 9px 0; font-size: 13px; color: ${AMBER}; background-color: ${AMBER_BG}; border-bottom: 1px solid ${RULE};">${escapeHtml(
        note
      )}</td>` +
      `</tr>`
    );
  }
  const r = d.row;
  return (
    `<tr>` +
    td(escapeHtml(dayLabel(d.business_date)), {
      align: "left",
      weight: 600,
      color: INK
    }) +
    td(fmtInt(r.wash_sales)) +
    td(fmtInt(r.sign_ups)) +
    td(goalCell(r.capture_pct, r.capture_goal_pct, "pct")) +
    td(goalCell(r.dob, r.dob_goal, "money")) +
    `</tr>`
  );
}

/**
 * Last week's figures, as one line under the table rather than a second set of
 * columns. Week-over-week is context, not the subject of this mail; giving it
 * its own columns would double the table's width for a comparison most readers
 * glance at once.
 */
function renderPriorNote(block: DigestSiteBlock): string {
  const p = block.prior;
  if (!p) return "";
  const t = block.totals;
  const capD = delta(t?.capture_pct ?? null, p.capture_pct);
  const dobD = delta(t?.dob ?? null, p.dob);
  const bits = [
    `washes ${fmtInt(p.wash_sales)}`,
    `capture ${fmtPct(p.capture_pct)}${capD === null ? "" : ` (${signed(capD)} this week)`}`,
    `DOB ${fmtMoney(p.dob)}${dobD === null ? "" : ` (${signedMoney(dobD)} this week)`}`
  ];
  return `<p style="margin: 0 0 4px 0; font-size: 12px; color: ${MUTED};">Prior week: ${escapeHtml(
    bits.join(" · ")
  )}</p>`;
}

/**
 * Every greeter who logged at this site during the week.
 *
 * Already sorted by digest.ts — worst capture first, low-sample rows pushed to
 * the bottom. Two days both missed reads as "100% under goal" and would
 * otherwise lead the section, which is how a new hire's first week gets them
 * named in mail to their regional manager.
 */
function renderGreeterTable(block: DigestSiteBlock): string {
  if (block.greeters.length === 0) {
    return (
      sectionHeader("Greeters") +
      `<p style="margin: 0 0 4px 0; font-size: 13px; color: ${MUTED};">No greeter logged a shift at this site last week.</p>`
    );
  }

  const body = block.greeters.map((g) => renderGreeterRow(g)).join("");
  const anyLowSample = block.greeters.some((g) => g.low_sample);

  return (
    sectionHeader("Greeters — week") +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 6px 0;">` +
    `<thead><tr>` +
    th("Greeter", "left") +
    th("Days") +
    th("Washes") +
    th("Sign-ups") +
    th("Capture") +
    th("DOB") +
    `</tr></thead><tbody>${body}</tbody></table>` +
    (anyLowSample
      ? `<p style="margin: 0 0 4px 0; font-size: 12px; color: ${MUTED};">Rows marked “few days” have under 5 gradeable days — the rate is real but it is not yet a trend.</p>`
      : "")
  );
}

function renderGreeterRow(g: GreeterPeriodReportRow): string {
  const name =
    escapeHtml(g.greeter_name) +
    (g.low_sample
      ? ` <span style="font-size: 11px; font-weight: 400; color: ${MUTED};">few days</span>`
      : "");
  // days_over_goal is shown against gradeable_days, not days_logged: an ungraded
  // day had no goal or no activity, and folding it into the denominator would
  // quietly mark it as a miss.
  const dayNote =
    g.gradeable_days > 0
      ? `<span style="font-size: 11px; color: ${MUTED};">${g.days_over_goal}/${g.gradeable_days} over</span>`
      : `<span style="font-size: 11px; color: ${MUTED};">not graded</span>`;
  return (
    `<tr>` +
    td(name, { align: "left", weight: 600, color: INK }) +
    td(`${g.days_logged}<br />${dayNote}`) +
    td(fmtInt(g.wash_sales)) +
    td(fmtInt(g.sign_ups)) +
    td(goalCell(g.capture_pct, g.capture_goal_pct, "pct")) +
    td(goalCell(g.dob, g.dob_goal, "money")) +
    `</tr>`
  );
}

/* ============================================================
 * Cell primitives
 * ============================================================ */

function sectionHeader(label: string): string {
  return `<p style="margin: 22px 0 6px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${MUTED};">${escapeHtml(
    label
  )}</p>`;
}

function th(label: string, align: "left" | "right" = "right"): string {
  return `<th align="${align}" style="padding: 0 0 6px 0; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: ${MUTED}; border-bottom: 1px solid ${RULE}; text-align: ${align};">${escapeHtml(
    label
  )}</th>`;
}

/**
 * `html` is inserted RAW — every caller escapes its own text, because several of
 * them pass markup (the goal sub-line, the low-sample tag). Escaping here would
 * print the tags; escaping in neither place would be the bug. If you add a
 * caller, escape at the call site.
 */
function td(
  html: string,
  opts: {
    align?: "left" | "right";
    weight?: number;
    color?: string;
    top?: boolean;
  } = {}
): string {
  const align = opts.align ?? "right";
  const border = opts.top
    ? `border-top: 2px solid ${RULE};`
    : `border-bottom: 1px solid ${RULE};`;
  const pad = align === "left" ? "9px 8px 9px 0" : "9px 0 9px 8px";
  return `<td align="${align}" style="padding: ${pad}; font-size: 13px; font-weight: ${
    opts.weight ?? 400
  }; color: ${opts.color ?? INK}; ${border} text-align: ${align};">${html}</td>`;
}

/**
 * A value with its goal underneath it.
 *
 * THE SUB-LINE IS THE POINT. Josh asked for "by day vs goals", and a bare 23.1%
 * is only a verdict if the reader already knows the goal for that day — which
 * they don't, because goals change mid-month and differ by site. The signed
 * delta and the goal itself are both there so no lookup is needed.
 *
 * `null` VALUE AND `null` GOAL MEAN DIFFERENT THINGS and render differently. No
 * value is an em dash: nothing happened, or nothing gradeable did. No goal is
 * "no goal set", which is an admin gap somebody should close, not a performance
 * result — showing it as a miss would blame the site for a missing config row.
 */
function goalCell(
  value: number | null,
  goal: number | null,
  kind: "pct" | "money"
): string {
  const fmt = kind === "pct" ? fmtPct : fmtMoney;
  if (value === null) {
    return `<span style="color: ${MUTED};">—</span>`;
  }
  if (goal === null) {
    return (
      `<span style="font-weight: 600; color: ${NAVY};">${escapeHtml(fmt(value))}</span>` +
      `<br /><span style="font-size: 11px; color: ${MUTED};">no goal set</span>`
    );
  }
  const d = delta(value, goal);
  const under = d !== null && d < 0;
  const sign = kind === "pct" ? signed : signedMoney;
  return (
    `<span style="font-weight: 600; color: ${under ? AMBER : NAVY};">${escapeHtml(fmt(value))}</span>` +
    `<br /><span style="font-size: 11px; color: ${under ? AMBER : MUTED};">${escapeHtml(
      `${d === null ? "" : `${sign(d)} vs `}${fmt(goal)}`
    )}</span>`
  );
}

/* ============================================================
 * Plain text
 *
 * Not a courtesy. enqueueOutboundEmail's two existing senders both supply
 * body_text, some corporate filters score a text-less multipart down, and this
 * is what a watch or a screen reader gets. Deliberately flat — no ASCII column
 * alignment, which breaks the moment a site name runs long.
 * ============================================================ */

function renderBodyText(
  blocks: DigestSiteBlock[],
  range: string,
  missingTotal: number,
  reportUrl: string | null
): string {
  const out: string[] = [`GREETER WEEK — ${range}`, ""];

  if (missingTotal > 0) {
    out.push(
      `${missingTotal} day${missingTotal === 1 ? "" : "s"} with no site submission:`
    );
    for (const b of blocks) {
      if (b.days_missing_site.length === 0) continue;
      out.push(`  ${b.location_code}: ${b.days_missing_site.map(dayLabel).join(", ")}`);
    }
    out.push("");
  } else {
    out.push("Every day reported.", "");
  }

  for (const b of blocks) {
    out.push(
      `--- ${b.site_number === null ? "" : `Site ${b.site_number} · `}${b.location_code} ---`
    );
    for (const d of b.days) {
      if (d.row === null) {
        out.push(
          `  ${dayLabel(d.business_date)}  NO SITE SUBMISSION${
            d.greeters_logged > 0 ? ` (${d.greeters_logged} greeter(s) logged)` : ""
          }`
        );
        continue;
      }
      out.push(
        `  ${dayLabel(d.business_date)}  washes ${fmtInt(d.row.wash_sales)}, sign-ups ${fmtInt(
          d.row.sign_ups
        )}, capture ${fmtPct(d.row.capture_pct)} (goal ${fmtPct(
          d.row.capture_goal_pct
        )}), DOB ${fmtMoney(d.row.dob)} (goal ${fmtMoney(d.row.dob_goal)})`
      );
    }
    const t = b.totals;
    out.push(
      t
        ? `  WEEK      washes ${fmtInt(t.wash_sales)}, sign-ups ${fmtInt(
            t.sign_ups
          )}, capture ${fmtPct(t.capture_pct)} (goal ${fmtPct(
            t.capture_goal_pct
          )}), DOB ${fmtMoney(t.dob)} (goal ${fmtMoney(t.dob_goal)})`
        : `  WEEK      no site submissions at all`
    );

    if (b.greeters.length === 0) {
      out.push(`  Greeters: none logged.`);
    } else {
      out.push(`  Greeters:`);
      for (const g of b.greeters) {
        out.push(
          `    ${g.greeter_name}${g.low_sample ? " (few days)" : ""} — ${
            g.days_logged
          } day(s), washes ${fmtInt(g.wash_sales)}, sign-ups ${fmtInt(
            g.sign_ups
          )}, capture ${fmtPct(g.capture_pct)} (goal ${fmtPct(
            g.capture_goal_pct
          )}), DOB ${fmtMoney(g.dob)}`
        );
      }
    }
    out.push("");
  }

  if (reportUrl) out.push(`Full report: ${reportUrl}`);
  return out.join("\n");
}

/* ============================================================
 * Formatting
 *
 * All locale-pinned to en-US and all dates read in UTC. A Worker's locale is
 * whatever the isolate happens to have, so an unpinned toLocaleString can put
 * European separators in one recipient's mail and not another's; and a business
 * date has no time zone at all, so parsing one as local would print the previous
 * day for anybody west of Greenwich.
 * ============================================================ */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
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
] as const;

function utcParts(iso: string): { y: number; m: number; d: number; dow: number } {
  const [ys, ms, ds] = iso.split("-");
  const y = Number(ys ?? 1970);
  const m = Number(ms ?? 1);
  const d = Number(ds ?? 1);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow };
}

/** `Mon 8/25` — the weekday matters as much as the date on a shift schedule. */
function dayLabel(iso: string): string {
  const { m, d, dow } = utcParts(iso);
  return `${DAY_NAMES[dow] ?? "?"} ${m}/${d}`;
}

/** `Aug 25 – Aug 31`, or `Aug 28 – Sep 3` when the week straddles a month. */
function rangeLabel(week: DigestWeek): string {
  const a = utcParts(week.from);
  const b = utcParts(week.to);
  const left = `${MONTH_NAMES[a.m - 1] ?? "?"} ${a.d}`;
  const right =
    a.m === b.m ? `${b.d}` : `${MONTH_NAMES[b.m - 1] ?? "?"} ${b.d}`;
  return `${left} – ${right}`;
}

function fmtInt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  })}%`;
}

function fmtMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/** A signed percentage-point delta. The sign is always printed, including on 0. */
function signed(v: number): string {
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
  return `${v < 0 ? "−" : "+"}${s}`;
}

function signedMoney(v: number): string {
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${v < 0 ? "−" : "+"}$${s}`;
}
