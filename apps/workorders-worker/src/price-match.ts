// Price Match (2026-11-14) -- NCS price-match requests by email.
//
// NCS (our MacNeil parts dealer) has offered to match any competitor's price.
// A request is a list of parts, each with the NCS price + estore link and the
// competitor's price, plus evidence for the competitor side: a link per part
// and/or attached quotes (PDF, photo, screenshot). This worker writes the
// email -- a table in the body, the same table as an .xlsx attachment, the
// quotes attached -- and queues it on outbound_emails.
//
// ROUTES (under /workorders/api/, dispatched from index.ts):
//   GET  price-match           recent requests + where an email would go
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
import { buildXlsxWorkbook, type XlsxColumn } from "@splash/xlsx";
import { easternYmd } from "./eastern-time.js";

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
export const MAX_FILES = 10;
/** forms-worker's queue claim drops attachments over 5 MB; match it. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|heic|heif|xlsx?|csv|docx?|txt)$/i;

export interface PriceMatchLine {
  part: string;
  ncs_part_no: string;
  qty: string;
  ncs_price: string;
  ncs_url: string;
  competitor_part_no: string;
  competitor_price: string;
  competitor_url: string;
}

export interface PriceMatchInput {
  competitor: string;
  note: string;
  lines: PriceMatchLine[];
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

export function parseInput(raw: unknown): { input: PriceMatchInput } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Nothing to send." };
  const b = raw as Record<string, unknown>;
  const competitor = str(b.competitor, 120);
  if (!competitor) return { error: "Name the competitor." };
  const note = str(b.note, 2000);
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  const lines: PriceMatchLine[] = [];
  for (const r of rawLines) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const line: PriceMatchLine = {
      part: str(o.part, 200),
      ncs_part_no: str(o.ncs_part_no, 60),
      qty: str(o.qty, 20),
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
    lines.push(line);
  }
  if (lines.length === 0) return { error: "Add at least one part." };
  if (lines.length > MAX_LINES) return { error: `At most ${MAX_LINES} parts per request.` };
  return { input: { competitor, note, lines } };
}

/** "$1,229.67" / "229.67" -> 229.67; "9.25/foot" -> null. */
export function priceNumber(s: string): number | null {
  const t = s.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function qtyNumber(s: string): number {
  const n = Number(s.trim());
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** NCS minus competitor, per unit. null when either side isn't a plain price. */
export function lineDiff(l: Pick<PriceMatchLine, "ncs_price" | "competitor_price">): number | null {
  const a = priceNumber(l.ncs_price);
  const b = priceNumber(l.competitor_price);
  return a == null || b == null ? null : Math.round((a - b) * 100) / 100;
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

/** Sum of (difference x qty) -- only when every line has a numeric difference. */
export function totalDiff(lines: PriceMatchLine[]): number | null {
  let total = 0;
  for (const l of lines) {
    const d = lineDiff(l);
    if (d == null) return null;
    total += d * qtyNumber(l.qty);
  }
  return Math.round(total * 100) / 100;
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

export function xlsxFilename(input: PriceMatchInput, at: Date): string {
  return `Price_Match_${slug(input.competitor)}_${easternYmd(at)}.xlsx`;
}

export function buildPriceMatchXlsx(input: PriceMatchInput): Uint8Array {
  const columns: XlsxColumn[] = [
    { header: "Part", width: 32, kind: "wrap" },
    { header: "NCS Part #", width: 14, kind: "text" },
    { header: "Qty", width: 7, kind: "text" },
    { header: "NCS Price", width: 13, kind: "currency" },
    { header: "NCS Link", width: 44, kind: "url" },
    { header: "Competitor", width: 24, kind: "text" },
    { header: "Competitor Part #", width: 16, kind: "text" },
    { header: "Competitor Price", width: 16, kind: "currency" },
    { header: "Competitor Link", width: 44, kind: "url" },
    { header: "Difference (each)", width: 16, kind: "currency" }
  ];
  const rows = input.lines.map((l) => {
    const d = lineDiff(l);
    return [
      l.part,
      l.ncs_part_no,
      l.qty,
      l.ncs_price,
      l.ncs_url,
      input.competitor,
      l.competitor_part_no,
      l.competitor_price,
      l.competitor_url,
      d == null ? "" : d
    ];
  });
  return buildXlsxWorkbook(columns, rows, "Price Match");
}

export function buildPriceMatchEmail(input: {
  request: PriceMatchInput;
  sender: string;
  fileNames: string[];
  xlsxName: string;
  test: { to: string; cc: string[] } | null;
}): { subject: string; html: string; text: string } {
  const { request, sender, fileNames, xlsxName, test } = input;
  const { competitor, note, lines } = request;
  const name = nameFromEmail(sender);
  const subject = `${test ? "[TEST] " : ""}Price Match Request - ${competitor}`;
  const hasNcsNo = lines.some((l) => l.ncs_part_no);
  const hasCompNo = lines.some((l) => l.competitor_part_no);
  const hasQty = lines.some((l) => l.qty);
  const hasCompLinks = lines.some((l) => l.competitor_url);
  const total = lines.length > 1 ? totalDiff(lines) : null;
  const quotes = fileNames.length > 0;

  const evidence =
    hasCompLinks && quotes
      ? `${competitor}'s pricing is linked for each part and their quote is attached.`
      : hasCompLinks
        ? `${competitor}'s pricing is linked for each part.`
        : quotes
          ? `${competitor}'s quote is attached.`
          : "";
  const intro = `We'd like to request a price match on the part${lines.length === 1 ? "" : "s"} below against ${competitor}.${evidence ? ` ${evidence}` : ""}`;

  const th = (s: string, right = false) =>
    `<th style="padding:6px 8px;border:1px solid #c9d1dc;background:#eef2f7;text-align:${right ? "right" : "left"};font-size:13px;white-space:nowrap;">${esc(s)}</th>`;
  const td = (s: string, right = false, nowrap = false) =>
    `<td style="padding:6px 8px;border:1px solid #c9d1dc;text-align:${right ? "right" : "left"};font-size:13px;vertical-align:top;${nowrap ? "white-space:nowrap;" : ""}">${s}</td>`;
  const link = (url: string, label: string) => (url ? `<a href="${esc(url)}" style="color:#1a5fb4;">${esc(label)}</a>` : "");

  const head = [
    th("Part"),
    hasNcsNo ? th("NCS Part #") : "",
    hasQty ? th("Qty", true) : "",
    th("NCS Price", true),
    th(`${competitor} Price`, true),
    th("Difference", true),
    th("Links")
  ].join("");
  const body = lines
    .map((l) => {
      const d = lineDiff(l);
      const links = [link(l.ncs_url, "NCS"), link(l.competitor_url, competitor)].filter(Boolean).join(" &middot; ");
      return (
        `<tr>` +
        td(esc(l.part) + (hasCompNo && l.competitor_part_no ? `<br><span style="color:#5b6b7f;font-size:12px;">${esc(competitor)} #: ${esc(l.competitor_part_no)}</span>` : "")) +
        (hasNcsNo ? td(esc(l.ncs_part_no), false, true) : "") +
        (hasQty ? td(esc(l.qty), true) : "") +
        td(esc(showPrice(l.ncs_price)), true, true) +
        td(esc(showPrice(l.competitor_price)), true, true) +
        td(d == null ? "&ndash;" : esc(money(d)), true, true) +
        td(links, false, true) +
        `</tr>`
      );
    })
    .join("");
  const span = 4 + (hasNcsNo ? 1 : 0) + (hasQty ? 1 : 0);
  const totalRow =
    total != null
      ? `<tr><td colspan="${span}" style="padding:6px 8px;border:1px solid #c9d1dc;text-align:right;font-size:13px;font-weight:bold;">Total difference${hasQty ? " (x qty)" : ""}</td>` +
        td(`<strong>${esc(money(total))}</strong>`, true, true) +
        td("") +
        `</tr>`
      : "";

  const p = (s: string) => `<p style="margin:0 0 12px;">${s}</p>`;
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
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;">`,
    `<tr>${head}</tr>`,
    body,
    totalRow,
    `</table>`,
    p(`Attached: ${attachedList.map(esc).join(", ")}.`),
    p("Thanks,"),
    p(`${esc(name)}<br>Splash Car Wash<br><a href="mailto:${esc(sender)}" style="color:#1a5fb4;">${esc(sender)}</a>`),
    `</div>`
  ].join("");

  const textLines = lines.map((l) => {
    const d = lineDiff(l);
    return [
      `- ${l.part}${l.ncs_part_no ? ` (NCS #${l.ncs_part_no})` : ""}${l.qty ? ` x${l.qty}` : ""}`,
      `  NCS ${showPrice(l.ncs_price)} vs ${competitor} ${showPrice(l.competitor_price)}${d == null ? "" : ` (difference ${money(d)})`}`,
      `  NCS: ${l.ncs_url}`,
      l.competitor_url ? `  ${competitor}: ${l.competitor_url}` : ""
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
    total != null ? `\nTotal difference: ${money(total)}` : "",
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
  method: "GET" | "POST",
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
  return text ? (JSON.parse(text) as T) : null;
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

async function overview(env: PriceMatchEnv, session: Session): Promise<Response> {
  const r = recipientsFor(env, session.email);
  const requests =
    (await pg<unknown[]>(
      env,
      "GET",
      `price_match_requests?select=id,ref_no,created_at,created_by_email,competitor,lines,files,sent_to,sent_cc,test&order=created_at.desc&limit=25`
    )) ?? [];
  return json({
    live: !r.test,
    to: r.to,
    cc: r.cc,
    live_recipients: liveRecipients(env),
    requests
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
  const fileNames = Array.isArray(raw.file_names) ? raw.file_names.filter((f): f is string => typeof f === "string").slice(0, MAX_FILES) : [];
  const r = recipientsFor(env, session.email);
  const email = buildPriceMatchEmail({
    request: parsed.input,
    sender: lc(session.email),
    fileNames,
    xlsxName: xlsxFilename(parsed.input, new Date()),
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

  // ---- build
  const me = lc(session.email);
  const now = new Date();
  const id = crypto.randomUUID();
  const r = recipientsFor(env, me);
  const xlsxName = xlsxFilename(req, now);
  const xlsx = buildPriceMatchXlsx(req);
  const email = buildPriceMatchEmail({
    request: req,
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

  // ---- send first: the email is the point, the history row is a record of it.
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
      files: stored,
      sent_to: r.to,
      sent_cc: r.cc,
      test: r.test,
      outbound_email_id: emailId
    },
    { Prefer: "return=representation" }
  );
  if (!row) console.error(`[price-match] history insert failed for ${id}; email ${emailId} is queued`);

  return json({ ok: true, id, ref_no: row?.[0]?.ref_no ?? null, to: r.to, cc: r.cc, test: r.test, subject: email.subject }, 201);
}
