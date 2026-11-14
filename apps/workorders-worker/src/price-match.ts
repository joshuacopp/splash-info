// Price Match (2026-11-14) -- NCS price-match requests by email.
//
// NCS (our MacNeil parts dealer) has offered to match any competitor's price.
// A request is a list of parts, each with the NCS price + estore link and the
// competitor's price, plus evidence for the competitor side: a link per part
// and/or attached quotes (PDF, photo, screenshot). This worker writes the
// email -- a table in the body, the same table as an .xlsx attachment, the
// quotes attached -- and queues it on outbound_emails.
//
// PRICES ARE PER UNIT. Quantities live only in the optional ORDER section
// (operator, 2026-11-14): pick one or more sites and a quantity per part per
// site, and the same email carries one PO per site -- "if you can match,
// process these". A Qty column on the price table read as either "the price
// for 10" or "10 at this price"; keeping quantities out of it removes that.
// Each site's ship-to comes from `locations` (ship_to_address, else
// location), exactly as Kleen-Rite orders do.
//
// POs use the Kleen-Rite format AND THE SAME SEQUENCE: {site#}-{YYYYMMDD}-
// {initials}, then 2, 3, ... Both supply_orders and price_match_orders are
// checked before a number is used, and Kleen-Rite's create checks ours.
// Test sends compute POs but do not reserve them.
//
// ROUTES (under /workorders/api/, dispatched from index.ts):
//   GET  price-match           recent requests, sites, where an email would go
//   POST price-match/preview   JSON body -> the email as it would be sent
//   POST price-match           multipart: data = JSON, files = quotes
//
// ACCESS: the `price_match` grant ONLY. Deliberately no super_admin bypass:
// the operator wanted this for himself alone, and every super_admin passing
// would mean four other people sending price-match emails to NCS.
//
// TEST MODE. Unless PRICE_MATCH_MODE is "live", the email goes to
// PRICE_MATCH_TEST_TO (else the sender) with no CC and "[TEST]" in the
// subject. Live: To = first PRICE_MATCH_TO address, CC = the rest + sender,
// reply-to the sender. One email rather than one per NCS rep, so both reps
// see the same thread and a reply-all reaches everyone.

import type { Session } from "@splash/auth";
import { enqueueOutboundEmail, type OutboundEmailAttachment } from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import { buildXlsxWorkbookMultiSheet, type XlsxColumn, type XlsxSheet } from "@splash/xlsx";
import { easternYmd } from "./eastern-time.js";
import { cleanInitials, initialsFrom, nextPo, poBase, shipToFor } from "./supply-orders.js";

export interface PriceMatchEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  WORKORDER_FILES?: R2Bucket;
  /** "live" sends to NCS. Anything else = test mode. */
  PRICE_MATCH_MODE?: string;
  /** Comma-separated. First is To, the rest are CC'd. */
  PRICE_MATCH_TO?: string;
  /** Test-mode recipient. Unset = the sender. */
  PRICE_MATCH_TEST_TO?: string;
}

export const MAX_LINES = 100;
export const MAX_SITES = 60;
export const MAX_FILES = 10;
/** forms-worker's queue claim drops attachments over 5 MB; match it. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
/** The company line on the shipping label -- same as Kleen-Rite orders. */
export const SHIP_TO_COMPANY = "Splash Express";
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|heic|heif|xlsx?|csv|docx?|txt)$/i;

export interface PriceMatchLine {
  part: string;
  ncs_part_no: string;
  ncs_price: string;
  ncs_url: string;
  competitor_part_no: string;
  competitor_price: string;
  competitor_url: string;
}

/** One site's order as typed: qty[i] belongs to lines[i]; 0 = not ordered. */
export interface OrderInput {
  location_id: number;
  qty: number[];
}

export interface PriceMatchInput {
  competitor: string;
  note: string;
  lines: PriceMatchLine[];
  orders: OrderInput[];
  /** PO initials as typed; null = derive from the sender. */
  initials: string | null;
}

/** An order resolved against `locations`, with its PO. */
export interface ResolvedOrder {
  location_id: number;
  site_number: number | null;
  site_name: string;
  po_number: string;
  ship_to: string;
  qty: number[];
}

/** The `locations` columns an order needs. */
export interface SitePick {
  id: number;
  site_number: number | null;
  site: string | null;
  location: string | null;
  ship_to_address: string | null;
}

/* ============================================================
 * Access + recipients
 * ============================================================ */

export function canUsePriceMatch(session: Session): boolean {
  return (session.tools as readonly string[]).includes("price_match");
}

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function liveMode(env: PriceMatchEnv): boolean {
  return lc(env.PRICE_MATCH_MODE) === "live";
}

export function liveRecipients(env: PriceMatchEnv): string[] {
  return (env.PRICE_MATCH_TO ?? "")
    .split(",")
    .map(lc)
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

export function recipientsFor(env: PriceMatchEnv, sender: string): { to: string; cc: string[]; test: boolean } {
  const me = lc(sender);
  if (!liveMode(env)) return { to: lc(env.PRICE_MATCH_TEST_TO) || me, cc: [], test: true };
  const [to, ...rest] = liveRecipients(env);
  if (!to) return { to: me, cc: [], test: true };
  const cc = [...new Set([...rest, me].filter((e) => e && e !== to))];
  return { to, cc, test: false };
}

/* ============================================================
 * Parsing
 * ============================================================ */

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "";
}

function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/** "" / "0" -> 0 (not ordered); "4" / "12.5" -> the number; anything else -> null. */
export function parseQty(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (s === "") return 0;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

export function parseInput(raw: unknown): { input: PriceMatchInput } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Nothing to send." };
  const b = raw as Record<string, unknown>;
  const competitor = str(b.competitor, 120);
  if (!competitor) return { error: "Name the competitor." };
  const note = str(b.note, 2000);
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  const lines: PriceMatchLine[] = [];
  /** raw line index -> kept line index (blank rows are dropped). */
  const keep = new Map<number, number>();
  for (const [ri, r] of rawLines.entries()) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const line: PriceMatchLine = {
      part: str(o.part, 200),
      ncs_part_no: str(o.ncs_part_no, 60),
      ncs_price: str(o.ncs_price, 40),
      ncs_url: str(o.ncs_url, 500),
      competitor_part_no: str(o.competitor_part_no, 60),
      competitor_price: str(o.competitor_price, 40),
      competitor_url: str(o.competitor_url, 500)
    };
    // A row the user left completely blank is not an error, just skipped.
    if (Object.values(line).every((v) => v === "")) continue;
    const n = lines.length + 1;
    if (!line.part) return { error: `Line ${n}: describe the part.` };
    if (!line.ncs_price) return { error: `Line ${n} (${line.part}): enter the NCS price.` };
    if (!line.competitor_price) return { error: `Line ${n} (${line.part}): enter the competitor's price.` };
    if (!isHttpUrl(line.ncs_url)) return { error: `Line ${n} (${line.part}): the NCS link must be a web address.` };
    if (line.competitor_url && !isHttpUrl(line.competitor_url)) {
      return { error: `Line ${n} (${line.part}): the competitor link must be a web address.` };
    }
    keep.set(ri, lines.length);
    lines.push(line);
  }
  if (lines.length === 0) return { error: "Add at least one part." };
  if (lines.length > MAX_LINES) return { error: `At most ${MAX_LINES} parts per request.` };

  const rawOrders = Array.isArray(b.orders) ? b.orders : [];
  if (rawOrders.length > MAX_SITES) return { error: `At most ${MAX_SITES} sites per request.` };
  const orders: OrderInput[] = [];
  const seen = new Set<number>();
  for (const r of rawOrders) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const location_id = Number(o.location_id);
    if (!Number.isInteger(location_id) || location_id <= 0) return { error: "An order has no site." };
    if (seen.has(location_id)) return { error: "The same site is in the order twice." };
    seen.add(location_id);
    const rawQty = Array.isArray(o.qty) ? o.qty : [];
    const qty = lines.map(() => 0);
    for (const [ri, ki] of keep) {
      const q = parseQty(rawQty[ri]);
      if (q === null) return { error: `${lines[ki]!.part}: quantities must be numbers, e.g. 4 or 12.5.` };
      qty[ki] = q;
    }
    orders.push({ location_id, qty });
  }

  let initials: string | null = null;
  if (typeof b.initials === "string" && b.initials.trim() !== "") {
    initials = cleanInitials(b.initials);
    if (!initials) return { error: "PO initials must be letters." };
  }
  return { input: { competitor, note, lines, orders, initials } };
}

/** "$1,229.67" / "229.67" -> 229.67; "9.25/foot" -> null. */
export function priceNumber(s: string): number | null {
  const t = s.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** NCS minus competitor, per unit. null when either side isn't a plain price. */
export function lineDiff(l: Pick<PriceMatchLine, "ncs_price" | "competitor_price">): number | null {
  const a = priceNumber(l.ncs_price);
  const b = priceNumber(l.competitor_price);
  return a == null || b == null ? null : Math.round((a - b) * 100) / 100;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** qty x matched (competitor) price; null when the price isn't a plain number. */
export function extended(line: PriceMatchLine, qty: number): number | null {
  const p = priceNumber(line.competitor_price);
  return p == null ? null : round2(p * qty);
}

/** A PO's total at matched prices -- null unless every ordered line has one. */
export function orderTotal(lines: PriceMatchLine[], qty: number[]): number | null {
  let t = 0;
  for (const [i, l] of lines.entries()) {
    if (!qty[i]) continue;
    const e = extended(l, qty[i]!);
    if (e == null) return null;
    t += e;
  }
  return round2(t);
}

/** What all the orders save against NCS pricing -- null unless every ordered line has a numeric difference. */
export function ordersSavings(lines: PriceMatchLine[], orders: Array<{ qty: number[] }>): number | null {
  let t = 0;
  let any = false;
  for (const o of orders) {
    for (const [i, l] of lines.entries()) {
      if (!o.qty[i]) continue;
      const d = lineDiff(l);
      if (d == null) return null;
      t += d * o.qty[i]!;
      any = true;
    }
  }
  return any ? round2(t) : null;
}

export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A price as typed, with "$" added to a bare number. */
export function showPrice(s: string): string {
  const n = priceNumber(s);
  return n == null ? s : money(n);
}

function showQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round2(n));
}

/** "147 - Binghamton" */
export function siteTitle(o: Pick<ResolvedOrder, "site_number" | "site_name">): string {
  return o.site_number != null ? `${String(o.site_number).padStart(3, "0")} - ${o.site_name}` : o.site_name;
}

/**
 * Turn typed orders into POs. `taken` is every PO already used (both
 * tables); POs given out earlier in this same call are added to it, so two
 * sites can never collide even if they share a site number.
 */
export function resolveOrders(
  orders: OrderInput[],
  sites: SitePick[],
  initials: string,
  at: Date,
  taken: string[]
): { orders: ResolvedOrder[] } | { error: string } {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const used = [...taken];
  const out: ResolvedOrder[] = [];
  for (const o of orders) {
    const s = byId.get(o.location_id);
    if (!s) return { error: "One of the order sites no longer exists. Remove it and add it again." };
    const site_name = (s.site ?? "").trim() || `Site ${s.site_number ?? s.id}`;
    if (!o.qty.some((q) => q > 0)) {
      return { error: `${site_name}: enter a quantity for at least one part, or remove the site.` };
    }
    const po_number = nextPo(poBase(s.site_number, at, initials), used);
    used.push(po_number);
    out.push({
      location_id: s.id,
      site_number: s.site_number,
      site_name,
      po_number,
      ship_to: shipToFor(s, SHIP_TO_COMPANY),
      qty: o.qty
    });
  }
  return { orders: out };
}

/* ============================================================
 * Email + spreadsheet
 * ============================================================ */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** "josh.copp@..." -> "Josh Copp". */
export function nameFromEmail(email: string): string {
  return (email.split("@")[0] ?? "")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Competitor";
}

export function xlsxFilename(input: Pick<PriceMatchInput, "competitor">, at: Date): string {
  return `Price_Match_${slug(input.competitor)}_${easternYmd(at)}.xlsx`;
}

export function buildPriceMatchXlsx(input: Pick<PriceMatchInput, "competitor" | "lines">, orders: ResolvedOrder[] = []): Uint8Array {
  const priceColumns: XlsxColumn[] = [
    { header: "Part", width: 32, kind: "wrap" },
    { header: "NCS Part #", width: 14, kind: "text" },
    { header: "NCS Price (each)", width: 15, kind: "currency" },
    { header: "NCS Link", width: 44, kind: "url" },
    { header: "Competitor", width: 24, kind: "text" },
    { header: "Competitor Part #", width: 16, kind: "text" },
    { header: "Competitor Price (each)", width: 20, kind: "currency" },
    { header: "Competitor Link", width: 44, kind: "url" },
    { header: "Difference (each)", width: 16, kind: "currency" }
  ];
  const priceRows = input.lines.map((l) => {
    const d = lineDiff(l);
    return [
      l.part,
      l.ncs_part_no,
      l.ncs_price,
      l.ncs_url,
      input.competitor,
      l.competitor_part_no,
      l.competitor_price,
      l.competitor_url,
      d == null ? "" : d
    ];
  });
  const sheets: XlsxSheet[] = [{ name: "Price Match", columns: priceColumns, rows: priceRows }];

  if (orders.length) {
    const orderColumns: XlsxColumn[] = [
      { header: "PO", width: 18, kind: "text" },
      { header: "Site", width: 24, kind: "text" },
      { header: "Ship To", width: 34, kind: "wrap" },
      { header: "Part", width: 32, kind: "wrap" },
      { header: "NCS Part #", width: 14, kind: "text" },
      { header: "Qty", width: 8, kind: "number" },
      { header: "Matched Price (each)", width: 18, kind: "currency" },
      { header: "Extended", width: 14, kind: "currency" },
      { header: "NCS Link", width: 44, kind: "url" }
    ];
    const orderRows = orders.flatMap((o) =>
      input.lines.flatMap((l, i) => {
        const q = o.qty[i] ?? 0;
        if (!q) return [];
        const e = extended(l, q);
        return [[o.po_number, siteTitle(o), o.ship_to, l.part, l.ncs_part_no, q, l.competitor_price, e == null ? "" : e, l.ncs_url]];
      })
    );
    sheets.push({ name: "Orders", columns: orderColumns, rows: orderRows });
  }
  return buildXlsxWorkbookMultiSheet(sheets);
}

export function emailSubject(competitor: string, orders: Pick<ResolvedOrder, "po_number">[], test: boolean): string {
  const po = orders.length === 1 ? ` + PO ${orders[0]!.po_number}` : orders.length > 1 ? ` + ${orders.length} POs` : "";
  return `${test ? "[TEST] " : ""}Price Match Request - ${competitor}${po}`;
}

export function buildPriceMatchEmail(input: {
  request: Pick<PriceMatchInput, "competitor" | "note" | "lines">;
  orders?: ResolvedOrder[];
  sender: string;
  fileNames: string[];
  xlsxName: string;
  test: { to: string; cc: string[] } | null;
}): { subject: string; html: string; text: string } {
  const { request, sender, fileNames, xlsxName, test } = input;
  const orders = input.orders ?? [];
  const { competitor, note, lines } = request;
  const name = nameFromEmail(sender);
  const subject = emailSubject(competitor, orders, test != null);
  const hasNcsNo = lines.some((l) => l.ncs_part_no);
  const hasCompNo = lines.some((l) => l.competitor_part_no);
  const hasCompLinks = lines.some((l) => l.competitor_url);
  const quotes = fileNames.length > 0;
  const savings = ordersSavings(lines, orders);

  const evidence =
    hasCompLinks && quotes
      ? `${competitor}'s pricing is linked for each part and their quote is attached.`
      : hasCompLinks
        ? `${competitor}'s pricing is linked for each part.`
        : quotes
          ? `${competitor}'s quote is attached.`
          : "";
  const intro =
    `We'd like to request a price match on the part${lines.length === 1 ? "" : "s"} below against ${competitor}. ` +
    `Prices are per unit.${evidence ? ` ${evidence}` : ""}`;
  const orderIntro =
    orders.length === 0
      ? ""
      : `If you can match these prices, please process the following order${orders.length === 1 ? "" : "s"} at the matched prices` +
        (orders.length === 1 ? "." : ` - one PO per site.`);

  const th = (s: string, right = false) =>
    `<th style="padding:6px 8px;border:1px solid #c9d1dc;background:#eef2f7;text-align:${right ? "right" : "left"};font-size:13px;white-space:nowrap;">${esc(s)}</th>`;
  const td = (s: string, right = false, nowrap = false) =>
    `<td style="padding:6px 8px;border:1px solid #c9d1dc;text-align:${right ? "right" : "left"};font-size:13px;vertical-align:top;${nowrap ? "white-space:nowrap;" : ""}">${s}</td>`;
  const link = (url: string, label: string) => (url ? `<a href="${esc(url)}" style="color:#1a5fb4;">${esc(label)}</a>` : "");
  const table = (rows: string[]) =>
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;">${rows.join("")}</table>`;
  const p = (s: string) => `<p style="margin:0 0 12px;">${s}</p>`;

  // ---- price table (per unit)
  const head = [
    th("Part"),
    hasNcsNo ? th("NCS Part #") : "",
    th("NCS Price (each)", true),
    th(`${competitor} Price (each)`, true),
    th("Difference (each)", true),
    th("Links")
  ].join("");
  const priceRows = lines.map((l) => {
    const d = lineDiff(l);
    const links = [link(l.ncs_url, "NCS"), link(l.competitor_url, competitor)].filter(Boolean).join(" &middot; ");
    return (
      `<tr>` +
      td(esc(l.part) + (hasCompNo && l.competitor_part_no ? `<br><span style="color:#5b6b7f;font-size:12px;">${esc(competitor)} #: ${esc(l.competitor_part_no)}</span>` : "")) +
      (hasNcsNo ? td(esc(l.ncs_part_no), false, true) : "") +
      td(esc(showPrice(l.ncs_price)), true, true) +
      td(esc(showPrice(l.competitor_price)), true, true) +
      td(d == null ? "&ndash;" : esc(money(d)), true, true) +
      td(links, false, true) +
      `</tr>`
    );
  });

  // ---- one block per PO
  const orderBlocks = orders.map((o) => {
    const rows = lines.flatMap((l, i) => {
      const q = o.qty[i] ?? 0;
      if (!q) return [];
      const e = extended(l, q);
      return [
        `<tr>` +
          td(esc(l.part)) +
          (hasNcsNo ? td(esc(l.ncs_part_no), false, true) : "") +
          td(esc(showQty(q)), true, true) +
          td(esc(showPrice(l.competitor_price)), true, true) +
          td(e == null ? "&ndash;" : esc(money(e)), true, true) +
          `</tr>`
      ];
    });
    const total = orderTotal(lines, o.qty);
    const span = 3 + (hasNcsNo ? 1 : 0);
    const totalRow =
      total != null
        ? `<tr><td colspan="${span}" style="padding:6px 8px;border:1px solid #c9d1dc;text-align:right;font-size:13px;font-weight:bold;">PO total</td>` +
          td(`<strong>${esc(money(total))}</strong>`, true, true) +
          `</tr>`
        : "";
    return [
      `<p style="margin:16px 0 4px;font-size:15px;"><strong>PO ${esc(o.po_number)}</strong> &mdash; ${esc(siteTitle(o))}</p>`,
      `<p style="margin:0 0 8px;color:#333;"><span style="color:#5b6b7f;">Ship to:</span><br>${esc(o.ship_to).replace(/\n/g, "<br>")}</p>`,
      table([
        `<tr>${th("Part")}${hasNcsNo ? th("NCS Part #") : ""}${th("Qty", true)}${th("Matched Price (each)", true)}${th("Extended", true)}</tr>`,
        ...rows,
        totalRow
      ])
    ].join("");
  });

  const attachedList = [xlsxName, ...fileNames];
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#111;">`,
    test
      ? p(
          `<strong style="color:#b42318;">TEST - not sent to NCS.</strong> Live, this goes to ${esc(test.to || "(PRICE_MATCH_TO not set)")}` +
            (test.cc.length ? `, CC ${esc(test.cc.join(", "))}` : "") +
            "."
        )
      : "",
    p("Hi,"),
    p(esc(intro)),
    note ? p(esc(note).replace(/\n/g, "<br>")) : "",
    table([`<tr>${head}</tr>`, ...priceRows]),
    orders.length
      ? `<h3 style="margin:20px 0 8px;font-size:16px;color:#0b2545;">Order${orders.length === 1 ? "" : "s"}</h3>` + p(esc(orderIntro))
      : "",
    ...orderBlocks,
    savings != null && savings > 0 ? p(`At the matched prices, ${orders.length === 1 ? "this order comes" : "these orders come"} to ${esc(money(savings))} less than NCS pricing.`) : "",
    p(`Attached: ${attachedList.map(esc).join(", ")}.`),
    p("Thanks,"),
    p(`${esc(name)}<br>Splash Car Wash<br><a href="mailto:${esc(sender)}" style="color:#1a5fb4;">${esc(sender)}</a>`),
    `</div>`
  ].join("");

  const textLines = lines.map((l) => {
    const d = lineDiff(l);
    return [
      `- ${l.part}${l.ncs_part_no ? ` (NCS #${l.ncs_part_no})` : ""}`,
      `  NCS ${showPrice(l.ncs_price)} vs ${competitor} ${showPrice(l.competitor_price)} each${d == null ? "" : ` (difference ${money(d)})`}`,
      `  NCS: ${l.ncs_url}`,
      l.competitor_url ? `  ${competitor}: ${l.competitor_url}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  });
  const textOrders = orders.map((o) => {
    const total = orderTotal(lines, o.qty);
    return [
      `PO ${o.po_number} - ${siteTitle(o)}`,
      `Ship to:`,
      ...o.ship_to.split("\n").map((s) => `  ${s}`),
      ...lines.flatMap((l, i) => {
        const q = o.qty[i] ?? 0;
        if (!q) return [];
        const e = extended(l, q);
        return [`  ${showQty(q)} x ${l.part}${l.ncs_part_no ? ` (NCS #${l.ncs_part_no})` : ""} @ ${showPrice(l.competitor_price)}${e == null ? "" : ` = ${money(e)}`}`];
      }),
      total != null ? `  PO total: ${money(total)}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  });
  const text = [
    test ? `TEST - not sent to NCS. Live, this goes to ${test.to}${test.cc.length ? `, CC ${test.cc.join(", ")}` : ""}.\n` : "",
    "Hi,",
    "",
    intro,
    note ? `\n${note}` : "",
    "",
    ...textLines,
    orders.length ? `\n${orderIntro}\n` : "",
    textOrders.join("\n\n"),
    savings != null && savings > 0 ? `\nAt the matched prices, ${orders.length === 1 ? "this order comes" : "these orders come"} to ${money(savings)} less than NCS pricing.` : "",
    "",
    `Attached: ${attachedList.join(", ")}.`,
    "",
    "Thanks,",
    name,
    "Splash Car Wash",
    sender
  ].join("\n");

  return { subject, html, text };
}

/* ============================================================
 * PostgREST
 * ============================================================ */

async function pg<T>(
  env: PriceMatchEnv,
  method: "GET" | "POST" | "DELETE",
  pathAndQuery: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    console.error(`[price-match] ${method} ${pathAndQuery.split("?")[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : []) as T;
}

const SITE_SELECT = "select=id,site_number,site,location,ship_to_address";

async function listSites(env: PriceMatchEnv): Promise<SitePick[]> {
  return (await pg<SitePick[]>(env, "GET", `locations?${SITE_SELECT}&order=site_number.asc,site.asc&limit=500`)) ?? [];
}

/**
 * Every PO already used on this date, in BOTH tables -- the PO sequence is
 * shared with Kleen-Rite orders. Null if either read failed: guessing would
 * hand out a PO that is already on an order.
 */
export async function takenPosOn(env: PriceMatchEnv, at: Date): Promise<string[] | null> {
  const day = `*-${easternYmd(at).replace(/-/g, "")}-*`;
  const q = `po_number=like.${encodeURIComponent(day)}&select=po_number`;
  const [a, b] = await Promise.all([
    pg<Array<{ po_number: string }>>(env, "GET", `supply_orders?${q}`),
    pg<Array<{ po_number: string }>>(env, "GET", `price_match_orders?${q}`)
  ]);
  if (!a || !b) return null;
  return [...a, ...b].map((r) => r.po_number);
}

/** Sites + POs for a request. Test sends compute POs without reserving them. */
async function ordersFor(
  env: PriceMatchEnv,
  req: PriceMatchInput,
  initials: string,
  at: Date
): Promise<{ orders: ResolvedOrder[] } | { error: string; status: number }> {
  if (req.orders.length === 0) return { orders: [] };
  const ids = req.orders.map((o) => o.location_id).join(",");
  const sites = await pg<SitePick[]>(env, "GET", `locations?id=in.(${ids})&${SITE_SELECT}`);
  if (!sites) return { error: "Could not look up the order sites. Try again.", status: 502 };
  const taken = await takenPosOn(env, at);
  if (!taken) return { error: "Could not check PO numbers. Try again.", status: 502 };
  const r = resolveOrders(req.orders, sites, initials, at, taken);
  return "error" in r ? { error: r.error, status: 400 } : r;
}

/* ============================================================
 * Dispatcher
 * ============================================================ */

export async function handlePriceMatchRequest(
  request: Request,
  env: PriceMatchEnv,
  path: string,
  session: Session
): Promise<Response> {
  if (!canUsePriceMatch(session)) return jsonError(403, "Price Match is not turned on for your login.");
  if (request.method !== "GET" && !isOriginAllowed(request)) return jsonError(403, "bad origin");
  const rest = path.replace(/^workorders\/api\/price-match\/?/, "");

  if (rest === "" && request.method === "GET") return overview(env, session);
  if (rest === "preview" && request.method === "POST") return preview(request, env, session);
  if (rest === "" && request.method === "POST") return send(request, env, session);
  return jsonError(404, "Not found");
}

function defaultInitials(session: Session): string {
  return initialsFrom(null, session.email) || "X";
}

async function overview(env: PriceMatchEnv, session: Session): Promise<Response> {
  const r = recipientsFor(env, session.email);
  const [requests, sites] = await Promise.all([
    pg<unknown[]>(
      env,
      "GET",
      `price_match_requests?select=id,ref_no,created_at,created_by_email,competitor,lines,orders,files,sent_to,sent_cc,test&order=created_at.desc&limit=25`
    ),
    listSites(env)
  ]);
  return json({
    live: !r.test,
    to: r.to,
    cc: r.cc,
    live_recipients: liveRecipients(env),
    initials: defaultInitials(session),
    today: easternYmd(new Date()).replace(/-/g, ""),
    sites: sites.map((s) => ({
      id: s.id,
      site_number: s.site_number,
      site: s.site,
      ship_to: shipToFor(s, SHIP_TO_COMPANY)
    })),
    requests: requests ?? []
  });
}

async function preview(request: Request, env: PriceMatchEnv, session: Session): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Bad request.");
  }
  const parsed = parseInput(raw);
  if ("error" in parsed) return jsonError(400, parsed.error);
  const now = new Date();
  const resolved = await ordersFor(env, parsed.input, parsed.input.initials ?? defaultInitials(session), now);
  if ("error" in resolved) return jsonError(resolved.status, resolved.error);
  const fileNames = Array.isArray(raw.file_names) ? raw.file_names.filter((f): f is string => typeof f === "string").slice(0, MAX_FILES) : [];
  const r = recipientsFor(env, session.email);
  const email = buildPriceMatchEmail({
    request: parsed.input,
    orders: resolved.orders,
    sender: lc(session.email),
    fileNames,
    xlsxName: xlsxFilename(parsed.input, now),
    test: r.test ? livePreviewTarget(env, session) : null
  });
  return json({ ...email, to: r.to, cc: r.cc, test: r.test });
}

function livePreviewTarget(env: PriceMatchEnv, session: Session): { to: string; cc: string[] } {
  const [to = "", ...rest] = liveRecipients(env);
  const me = lc(session.email);
  return { to, cc: [...new Set([...rest, me].filter((e) => e && e !== to))] };
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(-120);
  return cleaned || "quote";
}

/** What an order looks like stored: lines it orders, not the whole qty vector. */
function orderRecord(o: ResolvedOrder, lines: PriceMatchLine[]) {
  return {
    location_id: o.location_id,
    site_number: o.site_number,
    site_name: o.site_name,
    po_number: o.po_number,
    ship_to: o.ship_to,
    lines: lines.flatMap((l, i) =>
      o.qty[i] ? [{ part: l.part, ncs_part_no: l.ncs_part_no, qty: o.qty[i], matched_price: l.competitor_price }] : []
    )
  };
}

async function send(request: Request, env: PriceMatchEnv, session: Session): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Bad request.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("data") ?? ""));
  } catch {
    return jsonError(400, "Bad request.");
  }
  const parsed = parseInput(raw);
  if ("error" in parsed) return jsonError(400, parsed.error);
  const req = parsed.input;

  // ---- quotes
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  if (files.length > MAX_FILES) return jsonError(400, `At most ${MAX_FILES} attachments.`);
  let total = 0;
  const quotes: Array<{ name: string; mime: string; bytes: Uint8Array }> = [];
  const used = new Set<string>();
  for (const f of files) {
    const name = safeFilename(f.name);
    if (!FILE_EXT.test(name)) return jsonError(400, `${name}: attach a PDF, image, spreadsheet or document.`);
    if (f.size > MAX_FILE_BYTES) return jsonError(400, `${name} is over 5 MB.`);
    total += f.size;
    if (total > MAX_TOTAL_BYTES) return jsonError(400, "Attachments are over 15 MB in total.");
    // Two pasted screenshots are both "image.png"; Outlook would show two
    // identical names, so number the repeats.
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
    used.add(unique.toLowerCase());
    quotes.push({ name: unique, mime: f.type || "application/octet-stream", bytes: new Uint8Array(await f.arrayBuffer()) });
  }

  const me = lc(session.email);
  const now = new Date();
  const id = crypto.randomUUID();
  const r = recipientsFor(env, me);
  const initials = req.initials ?? defaultInitials(session);

  // ---- POs. Live POs are reserved BEFORE the email, so the number NCS sees
  // is one nobody else can take; the unique index on price_match_orders
  // settles a race (retry with fresh numbers). Released if the email fails.
  let orders: ResolvedOrder[] = [];
  for (let attempt = 0; ; attempt++) {
    const resolved = await ordersFor(env, req, initials, now);
    if ("error" in resolved) return jsonError(resolved.status, resolved.error);
    orders = resolved.orders;
    if (r.test || orders.length === 0) break;
    const ins = await pg<unknown[]>(
      env,
      "POST",
      "price_match_orders",
      orders.map((o) => ({ request_id: id, ...orderRecord(o, req.lines) })),
      { Prefer: "return=minimal" }
    );
    if (ins) break;
    if (attempt >= 3) return jsonError(502, "Could not reserve PO numbers. Nothing was sent -- try again.");
  }
  const releasePos = async () => {
    if (!r.test && orders.length) await pg(env, "DELETE", `price_match_orders?request_id=eq.${id}`);
  };

  // ---- build
  const xlsxName = xlsxFilename(req, now);
  const xlsx = buildPriceMatchXlsx(req, orders);
  const email = buildPriceMatchEmail({
    request: req,
    orders,
    sender: me,
    fileNames: quotes.map((q) => q.name),
    xlsxName,
    test: r.test ? livePreviewTarget(env, session) : null
  });
  const attachments: OutboundEmailAttachment[] = [
    {
      filename: xlsxName,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size_bytes: xlsx.length,
      base64: bytesToBase64(xlsx)
    },
    ...quotes.map((q) => ({ filename: q.name, mime: q.mime, size_bytes: q.bytes.length, base64: bytesToBase64(q.bytes) }))
  ];

  // ---- send: the email is the point, the history row is a record of it.
  let emailId: string;
  try {
    const res = await enqueueOutboundEmail(env, {
      source_worker: "workorders-worker",
      source_kind: "price-match",
      source_id: id,
      recipient: r.to,
      cc: r.cc,
      reply_to: me,
      subject: email.subject,
      body_html: email.html,
      body_text: email.text,
      attachments
    });
    emailId = res.id;
  } catch (err) {
    console.error("[price-match] enqueue failed", err);
    await releasePos();
    return jsonError(502, "The email could not be queued. Nothing was sent -- try again.");
  }

  // ---- record (fail-soft: the email is already queued)
  const stored: Array<{ filename: string; mime: string; size_bytes: number; r2_key: string | null }> = [];
  for (const [i, q] of [{ name: xlsxName, mime: attachments[0]!.mime, bytes: xlsx }, ...quotes].entries()) {
    const key = `price-match/${id}/${i}-${q.name}`;
    let ok = false;
    if (env.WORKORDER_FILES) {
      try {
        await env.WORKORDER_FILES.put(key, q.bytes, { httpMetadata: { contentType: q.mime } });
        ok = true;
      } catch (err) {
        console.error(`[price-match] R2 put failed for ${key}`, err);
      }
    }
    stored.push({ filename: q.name, mime: q.mime, size_bytes: q.bytes.length, r2_key: ok ? key : null });
  }
  const row = await pg<Array<{ ref_no: number }>>(
    env,
    "POST",
    "price_match_requests",
    {
      id,
      created_by_email: me,
      competitor: req.competitor,
      note: req.note || null,
      lines: req.lines,
      orders: orders.map((o) => orderRecord(o, req.lines)),
      files: stored,
      sent_to: r.to,
      sent_cc: r.cc,
      test: r.test,
      outbound_email_id: emailId
    },
    { Prefer: "return=representation" }
  );
  if (!row) console.error(`[price-match] history insert failed for ${id}; email ${emailId} is queued`);

  return json(
    {
      ok: true,
      id,
      ref_no: row?.[0]?.ref_no ?? null,
      to: r.to,
      cc: r.cc,
      test: r.test,
      subject: email.subject,
      po_numbers: orders.map((o) => o.po_number)
    },
    201
  );
}
