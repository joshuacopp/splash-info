// Supply Orders (2026-11-13) -- Kleen-Rite ordering with RM approval.
//
// Kleen-Rite has no punchout for us, so orders go by email. Before this a GM
// copied item #, description and quantity off kleen-rite.com into an email to
// their RM, who checked it and forwarded it to sales@kleen-ritecorp.com. Here
// a GM builds a cart from Kleen-Rite's catalog (supply-orders-catalog.ts), the
// site's RM approves it, and this worker writes the vendor email -- reply-to
// the RM, CC the site.
//
// ROUTES (all under /workorders/api/, dispatched from index.ts):
//   GET  supply-orders/meta               sites I can order for + who approves
//   GET  supply-orders/catalog            Kleen-Rite search (q, category, page)
//   POST supply-orders/catalog/prices     public prices for product paths
//   GET  supply-orders/recent?location_id items ordered at that site lately
//   GET  supply-orders                    orders I can see (status=open|all)
//   POST supply-orders                    place an order
//   GET  supply-orders/{id}               order + lines + timeline
//   POST supply-orders/{id}/approve       approver: optional qty edits, then send
//   POST supply-orders/{id}/deny          approver: note required
//   POST supply-orders/{id}/cancel        orderer, while still pending
//
// WHO DOES WHAT.
//   * ORDERING needs the `supply_orders` grant (super_admin implicitly), and
//     only for sites the person belongs to: their email is the site's
//     am / rm / site / gm email, or the site's location_code is one of their
//     assigned locations. Admin tier may order for any site.
//   * APPROVING needs no grant. The site's RM (rm_email) -- or RD (am_email),
//     or admin tier as an escape hatch -- approves. Most RMs will not hold the
//     grant; they reach an order from the email it sends them.
//   * An order placed BY someone who could approve it (the site's RM / RD,
//     admin tier) needs no approval and sends at once (operator, 2026-11-13).
//
// ONE SEND PATH. A direct order is created pending with the orderer as its
// approver and then goes through approveAndSend() exactly like an approved
// one. If the vendor email cannot be queued the order stays pending -- in the
// orderer's own queue for a direct order -- and approving again retries it.
// Never fork that path, or the two ways an order leaves will drift on what
// the email says.
//
// TEST MODE. Unless SUPPLY_ORDERS_MODE is "live", the vendor email goes to
// SUPPLY_ORDERS_TEST_TO with no CC and "[TEST]" in the subject, so the tool
// can be tried without ordering anything from Kleen-Rite.

import type { Session } from "@splash/auth";
import { enqueueOutboundEmail } from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import { easternYmd } from "./eastern-time.js";
import {
  DEPARTMENTS,
  KR_ORIGIN,
  isProductPath,
  productInfoFor,
  searchCatalog
} from "./supply-orders-catalog.js";
import { sendApprovalRequestEmail, sendDecisionEmail, buildVendorEmail } from "./supply-orders-email.js";

export interface SupplyOrdersEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  APPS_WEB_BASE_URL: string;
  /** "live" sends to the vendor. Anything else = test mode. */
  SUPPLY_ORDERS_MODE?: string;
  /** Test-mode recipient of the vendor email. */
  SUPPLY_ORDERS_TEST_TO?: string;
}

const VENDOR = "kleen_rite";
const MAX_LINES = 100;
const MAX_QTY = 9999;
const NOTE_MAX = 1000;

/* ============================================================
 * Types
 * ============================================================ */

export type OrderStatus = "pending_approval" | "sent" | "denied" | "cancelled";

export interface SiteRow {
  id: number;
  site: string | null;
  site_number: number | null;
  location: string | null;
  ship_to_address: string | null;
  location_code: string | null;
  site_email: string | null;
  rm_email: string | null;
  regional_manager: string | null;
  am_email: string | null;
  area_manager: string | null;
  gm: string | null;
  gm_email: string | null;
}

export interface VendorRow {
  vendor: string;
  display_name: string;
  account_no: string;
  order_email: string;
  ship_to_company: string;
  shipping_method: string;
}

export interface OrderRow {
  id: string;
  ref_no: number;
  vendor: string;
  location_id: number;
  site_number: number | null;
  site_name: string;
  po_number: string;
  status: OrderStatus;
  ordered_by_email: string;
  orderer_initials: string;
  note: string | null;
  approver_email: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  account_no: string;
  ship_to: string;
  shipping_method: string;
  vendor_email_to: string | null;
  vendor_email_cc: string[];
  vendor_reply_to: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LineRow {
  id: number;
  order_id: string;
  line_no: number;
  sku: string;
  name: string;
  uom: string | null;
  qty: number;
  unit_price_cents: number | null;
  product_url: string | null;
  image_url: string | null;
  source: "catalog" | "manual";
}

export interface EventRow {
  id: number;
  order_id: string;
  at: string;
  kind: string;
  actor_email: string | null;
  note: string | null;
  details: Record<string, unknown>;
}

/* ============================================================
 * PostgREST
 * ============================================================ */

async function pg<T>(
  env: SupplyOrdersEnv,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  pathAndQuery: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ ok: boolean; status: number; data: T | null }> {
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
    console.error(`[supply-orders] ${method} ${pathAndQuery.split("?")[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { ok: false, status: res.status, data: null };
  }
  const text = await res.text();
  return { ok: true, status: res.status, data: text ? (JSON.parse(text) as T) : null };
}

const SITE_SELECT =
  "select=id,site,site_number,location,ship_to_address,location_code,site_email,rm_email,regional_manager,am_email,area_manager,gm,gm_email";

async function getVendor(env: SupplyOrdersEnv): Promise<VendorRow | null> {
  const r = await pg<VendorRow[]>(env, "GET", `supply_order_vendors?vendor=eq.${VENDOR}&select=*`);
  return r.data?.[0] ?? null;
}

async function getSite(env: SupplyOrdersEnv, id: number): Promise<SiteRow | null> {
  const r = await pg<SiteRow[]>(env, "GET", `locations?id=eq.${id}&${SITE_SELECT}`);
  return r.data?.[0] ?? null;
}

async function getOrder(env: SupplyOrdersEnv, id: string): Promise<OrderRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pg<OrderRow[]>(env, "GET", `supply_orders?id=eq.${id}&select=*`);
  return r.data?.[0] ?? null;
}

export async function getLines(env: SupplyOrdersEnv, orderId: string): Promise<LineRow[]> {
  const r = await pg<LineRow[]>(env, "GET", `supply_order_lines?order_id=eq.${orderId}&select=*&order=line_no.asc`);
  return r.data ?? [];
}

async function getEvents(env: SupplyOrdersEnv, orderId: string): Promise<EventRow[]> {
  const r = await pg<EventRow[]>(env, "GET", `supply_order_events?order_id=eq.${orderId}&select=*&order=at.asc,id.asc`);
  return r.data ?? [];
}

async function addEvent(
  env: SupplyOrdersEnv,
  orderId: string,
  kind: string,
  actor: string | null,
  note: string | null = null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await pg(env, "POST", "supply_order_events", { order_id: orderId, kind, actor_email: actor, note, details });
}

async function patchOrder(env: SupplyOrdersEnv, id: string, patch: Partial<OrderRow>, extraFilter = ""): Promise<OrderRow | null> {
  const r = await pg<OrderRow[]>(
    env,
    "PATCH",
    `supply_orders?id=eq.${id}${extraFilter}`,
    { ...patch, updated_at: new Date().toISOString() },
    { Prefer: "return=representation" }
  );
  return r.data?.[0] ?? null;
}

/* ============================================================
 * Access
 * ============================================================ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function isAdminTier(session: Session): boolean {
  return session.role === "super_admin" || session.dcRole === "admin" || session.dcRole === "super_admin";
}

/** Placing orders. Mirrored in apps/web (tile + pages); this one counts. */
export function canOrder(session: Session): boolean {
  return session.role === "super_admin" || (session.tools as readonly string[]).includes("supply_orders");
}

/** The site's RM, or RD, or admin tier (escape hatch). */
export function canApproveFor(session: Session, site: Pick<SiteRow, "rm_email" | "am_email">): boolean {
  if (isAdminTier(session)) return true;
  const me = lc(session.email);
  return !!me && (me === lc(site.rm_email) || me === lc(site.am_email));
}

/** Who an order at this site waits on: the RM, else the RD. */
export function approverFor(site: Pick<SiteRow, "rm_email" | "am_email">): string | null {
  return lc(site.rm_email) || lc(site.am_email) || null;
}

/** Sites the caller belongs to (email on the site, or an assigned location). */
async function memberSites(env: SupplyOrdersEnv, session: Session): Promise<{ all: boolean; sites: SiteRow[] }> {
  const order = "order=site_number.asc,site.asc&limit=500";
  if (isAdminTier(session)) {
    const r = await pg<SiteRow[]>(env, "GET", `locations?${SITE_SELECT}&${order}`);
    return { all: true, sites: r.data ?? [] };
  }
  const me = lc(session.email);
  const clauses: string[] = [];
  if (me) {
    const e = encodeURIComponent(me);
    clauses.push(`am_email.eq.${e}`, `rm_email.eq.${e}`, `site_email.eq.${e}`, `gm_email.eq.${e}`);
  }
  const codes = session.locations.map((c) => c.trim().toLowerCase()).filter((c) => /^[a-z0-9_-]+$/.test(c));
  if (codes.length) clauses.push(`location_code.in.(${codes.join(",")})`);
  if (clauses.length === 0) return { all: false, sites: [] };
  const r = await pg<SiteRow[]>(env, "GET", `locations?or=(${clauses.join(",")})&${SITE_SELECT}&${order}`);
  return { all: false, sites: r.data ?? [] };
}

function canSeeOrder(session: Session, order: OrderRow, site: SiteRow | null, memberSiteIds: Set<number>): boolean {
  if (isAdminTier(session)) return true;
  const me = lc(session.email);
  if (me && (me === lc(order.ordered_by_email) || me === lc(order.approver_email))) return true;
  if (site && canApproveFor(session, site)) return true;
  return memberSiteIds.has(order.location_id);
}

/* ============================================================
 * Rules (pure -- tested in supply-orders.test.ts)
 * ============================================================ */

/**
 * PO initials, in the operator's own format: "Bm" for Bobbijo Mathews.
 * From a "First Last" name when we have one (the site's GM, when the GM or
 * the site's shared login is ordering), else from a first.last email.
 */
export function initialsFrom(name: string | null | undefined, email: string | null | undefined): string {
  const fmt = (letters: string[]) => {
    const s = letters.filter(Boolean).join("").toLowerCase();
    return s ? s[0]!.toUpperCase() + s.slice(1) : "";
  };
  const words = (name ?? "").split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, "")).filter(Boolean);
  if (words.length >= 2) return fmt([words[0]![0]!, words[words.length - 1]![0]!]);
  const local = lc(email).split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).map((p) => p.replace(/[^a-z]/g, "")).filter(Boolean);
  if (parts.length >= 2) return fmt([parts[0]![0]!, parts[parts.length - 1]![0]!]);
  if (words.length === 1) return fmt([words[0]!.slice(0, 2)]);
  return fmt([(parts[0] ?? "").slice(0, 2)]);
}

/** Typed initials: letters only, 1-4, keeping the person's own casing. */
export function cleanInitials(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^A-Za-z]/g, "").slice(0, 4);
  return s.length >= 1 ? s : null;
}

export function poBase(siteNumber: number | null, at: Date, initials: string): string {
  const num = siteNumber != null ? String(siteNumber).padStart(3, "0") : "000";
  return `${num}-${easternYmd(at).replace(/-/g, "")}-${initials}`;
}

/**
 * The next free PO for a base: the base itself, then base2, base3, ...
 * ("gm initials then 2/3/4" -- operator, 2026-11-13). Case-insensitive, so
 * "Bm" and "BM" on the same day do not read as two different orders.
 */
export function nextPo(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base}${n}`;
    if (!used.has(c.toLowerCase())) return c;
  }
  return `${base}${Date.now()}`;
}

/**
 * A one-line site address as a mailing label: street, then "City, ST ZIP".
 * Asides in parentheses ("(Route 11)", "(LeRay)") are dropped -- they are
 * not part of a postal address. Anything that doesn't end in a state and ZIP
 * after a comma-separated city is passed through as one line.
 */
export function addressLines(raw: string): string[] {
  const a = raw.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (!a) return [];
  const m = a.match(/^(.*?),?\s+([A-Za-z]{2}),?\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) return [a];
  const parts = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [a];
  const city = parts.pop()!;
  return [parts.join(", "), `${city}, ${m[2]!.toUpperCase()} ${m[3]}`];
}

/** The shipping block: company line, street, "City, ST ZIP". */
export function shipToFor(site: Pick<SiteRow, "ship_to_address" | "location">, company: string): string {
  const addr = (site.ship_to_address ?? "").trim() || (site.location ?? "").trim();
  return [company.trim(), ...addressLines(addr)].filter(Boolean).join("\n");
}

export interface LineInput {
  sku: string;
  name: string;
  uom: string | null;
  qty: number;
  unit_price_cents: number | null;
  product_url: string | null;
  image_url: string | null;
  source: "catalog" | "manual";
}

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/#+-]{0,39}$/;

/**
 * Validate the cart. The same SKU twice collapses into one line (quantities
 * added), so Kleen-Rite never sees an item listed twice.
 */
export function parseLines(raw: unknown): { lines: LineInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Add at least one item." };
  if (raw.length > MAX_LINES) return { error: `At most ${MAX_LINES} items per order.` };
  const bySku = new Map<string, LineInput>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") return { error: `Item ${i + 1} is not readable.` };
    const r = item as Record<string, unknown>;
    const sku = typeof r.sku === "string" ? r.sku.trim().toUpperCase() : "";
    const name = typeof r.name === "string" ? r.name.trim().replace(/\s+/g, " ").slice(0, 300) : "";
    const qty = typeof r.qty === "number" ? r.qty : Number.parseInt(String(r.qty ?? ""), 10);
    if (!SKU_RE.test(sku)) return { error: `Item ${i + 1}: enter the Kleen-Rite item # (letters and numbers).` };
    if (!name) return { error: `Item ${i + 1} (${sku}): enter a description.` };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: `${sku}: quantity must be 1 to ${MAX_QTY}.` };
    const price =
      typeof r.unit_price_cents === "number" && Number.isInteger(r.unit_price_cents) && r.unit_price_cents >= 0 && r.unit_price_cents < 100_000_000
        ? r.unit_price_cents
        : null;
    const path = typeof r.product_path === "string" ? r.product_path.trim() : "";
    const img = typeof r.image_url === "string" ? r.image_url.trim() : "";
    const source = r.source === "catalog" && isProductPath(path) ? "catalog" : "manual";
    const existing = bySku.get(sku);
    if (existing) {
      existing.qty = Math.min(MAX_QTY, existing.qty + qty);
      continue;
    }
    bySku.set(sku, {
      sku,
      name,
      uom: typeof r.uom === "string" && r.uom.trim() ? r.uom.trim().slice(0, 30) : null,
      qty,
      unit_price_cents: price,
      product_url: source === "catalog" ? `${KR_ORIGIN}/${path}` : null,
      image_url: img.startsWith("https://cdn.kleen-ritecorp.com/") ? img.slice(0, 500) : null,
      source
    });
  }
  return { lines: [...bySku.values()] };
}

/**
 * Approver edits: {line_no, qty} pairs, qty 0 removes the line. Lines not
 * mentioned keep their quantity. At least one line must survive.
 */
export function applyQtyEdits(
  lines: Pick<LineRow, "line_no" | "sku" | "qty">[],
  raw: unknown
): { changes: Array<{ line_no: number; sku: string; from: number; to: number }> } | { error: string } {
  if (raw === undefined || raw === null) return { changes: [] };
  if (!Array.isArray(raw)) return { error: "Could not read the quantity changes." };
  const byNo = new Map(lines.map((l) => [l.line_no, l]));
  const changes: Array<{ line_no: number; sku: string; from: number; to: number }> = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const no = Number(r.line_no);
    const qty = Number(r.qty);
    const line = byNo.get(no);
    if (!line) return { error: "A changed line is not on this order." };
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) return { error: `${line.sku}: quantity must be 0 to ${MAX_QTY}.` };
    if (qty !== line.qty) changes.push({ line_no: no, sku: line.sku, from: line.qty, to: qty });
  }
  const removed = new Set(changes.filter((c) => c.to === 0).map((c) => c.line_no));
  if (lines.every((l) => removed.has(l.line_no))) return { error: "Every item would be removed -- deny the order instead." };
  return { changes };
}

export function liveMode(env: SupplyOrdersEnv): boolean {
  return (env.SUPPLY_ORDERS_MODE ?? "").trim().toLowerCase() === "live";
}

/* ============================================================
 * Input helpers
 * ============================================================ */

type Body = Record<string, unknown>;

async function readJson(request: Request): Promise<Body | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : null;
  } catch {
    return null;
  }
}

function note(body: Body, key: string): string | null {
  const v = body[key];
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, NOTE_MAX);
  return s || null;
}

function siteLabel(s: Pick<SiteRow, "site" | "site_number">): string {
  const num = s.site_number != null ? String(s.site_number).padStart(3, "0") : "";
  return [num, s.site ?? ""].filter(Boolean).join(" ");
}

/* ============================================================
 * Dispatcher
 * ============================================================ */

export async function handleSupplyOrdersRequest(
  request: Request,
  env: SupplyOrdersEnv,
  path: string,
  session: Session,
  ctx: ExecutionContext
): Promise<Response> {
  const rest = path.replace(/^workorders\/api\/supply-orders\/?/, "");
  const [first, action] = rest.split("/");
  const url = new URL(request.url);

  if (request.method !== "GET" && !isOriginAllowed(request)) return jsonError(403, "bad origin");

  if (first === "meta" && request.method === "GET") return meta(env, session);

  if (first === "catalog") {
    if (!canOrder(session)) return jsonError(403, "Kleen-Rite ordering is not turned on for your login.");
    if (!action && request.method === "GET") {
      const page = await searchCatalog(
        (url.searchParams.get("q") ?? "").trim(),
        (url.searchParams.get("category") ?? "").trim(),
        Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1
      );
      if (!page) return jsonError(502, "Kleen-Rite's catalog did not answer. Add items by item # instead.");
      return json(page);
    }
    if (action === "prices" && request.method === "POST") {
      const body = await readJson(request);
      const paths = Array.isArray(body?.paths) ? body!.paths.filter((p): p is string => typeof p === "string") : [];
      const info = await productInfoFor(paths);
      // `prices` kept alongside `info` so a page from before item details
      // existed keeps working through a deploy.
      const prices = Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.cents]));
      return json({ prices, info });
    }
    return jsonError(405, "method not allowed");
  }

  if (first === "recent" && request.method === "GET") return recentItems(env, session, url);

  if (!first) {
    if (request.method === "GET") return listOrders(env, session, url);
    if (request.method === "POST") return createOrder(request, env, session, ctx);
    return jsonError(405, "method not allowed");
  }

  const order = await getOrder(env, first);
  if (!order) return jsonError(404, "Order not found.");
  const site = await getSite(env, order.location_id);
  const member = await memberSites(env, session);
  if (!canSeeOrder(session, order, site, new Set(member.sites.map((s) => s.id)))) {
    // Same answer as a missing order: do not confirm an id exists.
    return jsonError(404, "Order not found.");
  }

  if (!action && request.method === "GET") return orderDetail(env, session, order, site);
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  const body = (await readJson(request)) ?? {};
  if (action === "approve") return approve(env, session, order, site, body, ctx);
  if (action === "deny") return deny(env, session, order, site, body, ctx);
  if (action === "cancel") return cancel(env, session, order);
  return jsonError(404, "Not found");
}

/* ============================================================
 * Handlers
 * ============================================================ */

async function meta(env: SupplyOrdersEnv, session: Session): Promise<Response> {
  const [vendor, member] = await Promise.all([getVendor(env), memberSites(env, session)]);
  const me = lc(session.email);
  const sites = member.sites.map((s) => {
    const direct = canApproveFor(session, s);
    // The GM's name gives the initials when the GM -- or the site's shared
    // login -- is ordering; otherwise the orderer's own email does.
    const isSite = !!me && (me === lc(s.gm_email) || me === lc(s.site_email));
    return {
      id: s.id,
      site_number: s.site_number,
      site: s.site,
      label: siteLabel(s),
      needs_approval: !direct,
      approver_email: direct ? null : approverFor(s),
      approver_name: direct ? null : s.rm_email ? s.regional_manager : s.area_manager,
      ship_to: vendor ? shipToFor(s, vendor.ship_to_company) : (s.ship_to_address ?? s.location ?? ""),
      initials: initialsFrom(isSite ? s.gm : null, isSite ? s.gm_email : me) || "Xx"
    };
  });
  return json({
    can_order: canOrder(session),
    live: liveMode(env),
    vendor: vendor ? { display_name: vendor.display_name, account_no: vendor.account_no, shipping_method: vendor.shipping_method } : null,
    sites,
    departments: DEPARTMENTS,
    today: easternYmd(new Date())
  });
}

/** Company-wide "Commonly ordered at Splash" (supply-orders-02 seed). */
async function commonItems(env: SupplyOrdersEnv): Promise<
  Array<{ sku: string; name: string; uom: string | null; image_url: string | null; product_path: string | null; typical_qty: number; times: number }>
> {
  const r = await pg<
    Array<{ sku: string; name: string; uom: string | null; image_url: string | null; product_path: string | null; typical_qty: number; times_ordered: number }>
  >(
    env,
    "GET",
    `supply_order_common_items?vendor=eq.${VENDOR}&active=is.true&select=sku,name,uom,image_url,product_path,typical_qty,times_ordered&order=times_ordered.desc,name.asc&limit=300`
  );
  return (r.data ?? []).map(({ times_ordered, ...c }) => ({
    ...c,
    product_path: c.product_path && isProductPath(c.product_path) ? c.product_path : null,
    times: times_ordered
  }));
}

/**
 * The "Ordered before" tab: `items` = this site's own history (last 25 sent
 * orders), `common` = the company-wide list minus anything already in
 * `items`. A site with no orders yet still gets a useful list.
 */
async function recentItems(env: SupplyOrdersEnv, session: Session, url: URL): Promise<Response> {
  if (!canOrder(session)) return jsonError(403, "Kleen-Rite ordering is not turned on for your login.");
  const id = Number.parseInt(url.searchParams.get("location_id") ?? "", 10);
  const member = await memberSites(env, session);
  const common = await commonItems(env);
  if (!Number.isInteger(id) || !member.sites.some((s) => s.id === id)) return json({ items: [], common });
  // Items on this site's last 25 sent orders, most-ordered first.
  const orders = await pg<Array<{ id: string; sent_at: string }>>(
    env,
    "GET",
    `supply_orders?location_id=eq.${id}&status=eq.sent&select=id,sent_at&order=sent_at.desc&limit=25`
  );
  const ids = (orders.data ?? []).map((o) => o.id);
  if (ids.length === 0) return json({ items: [], common });
  const lines = await pg<LineRow[]>(env, "GET", `supply_order_lines?order_id=in.(${ids.join(",")})&select=*`);
  const bySku = new Map<string, LineRow & { times: number; last_qty: number }>();
  const rank = new Map(ids.map((oid, i) => [oid, i]));
  for (const l of (lines.data ?? []).sort((a, b) => (rank.get(a.order_id) ?? 0) - (rank.get(b.order_id) ?? 0))) {
    const e = bySku.get(l.sku);
    if (e) e.times += 1;
    else bySku.set(l.sku, { ...l, times: 1, last_qty: l.qty });
  }
  const items = [...bySku.values()]
    .sort((a, b) => b.times - a.times)
    .slice(0, 30)
    .map((l) => ({
      sku: l.sku,
      name: l.name,
      uom: l.uom,
      image_url: l.image_url,
      product_path: l.product_url ? l.product_url.replace(`${KR_ORIGIN}/`, "") : null,
      unit_price_cents: l.unit_price_cents,
      last_qty: l.last_qty,
      times: l.times
    }));
  const mine = new Set(items.map((i) => i.sku.toUpperCase()));
  return json({ items, common: common.filter((c) => !mine.has(c.sku.toUpperCase())) });
}

async function listOrders(env: SupplyOrdersEnv, session: Session, url: URL): Promise<Response> {
  const status = url.searchParams.get("status") === "all" ? "all" : "open";
  const member = await memberSites(env, session);
  const me = lc(session.email);
  const filters: string[] = [];
  if (!member.all) {
    const e = encodeURIComponent(me);
    const clauses = me ? [`ordered_by_email.eq.${e}`, `approver_email.eq.${e}`] : [];
    if (member.sites.length) clauses.push(`location_id.in.(${member.sites.map((s) => s.id).join(",")})`);
    if (clauses.length === 0) return json({ orders: [], can_order: canOrder(session) });
    filters.push(`or=(${clauses.join(",")})`);
  }
  if (status === "open") {
    // Open = still waiting, plus anything decided in the last 14 days.
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    filters.push(`or=(status.eq.pending_approval,updated_at.gte."${since}")`);
  }
  // PostgREST rejects two `or` params; fold them into one `and` when both apply.
  const q =
    filters.length === 2
      ? `and=(${filters.map((f) => f.replace(/^or=/, "or")).join(",")})`
      : filters.join("&");
  const r = await pg<Array<OrderRow & { supply_order_lines: Array<{ qty: number; unit_price_cents: number | null }> }>>(
    env,
    "GET",
    `supply_orders?select=*,supply_order_lines(qty,unit_price_cents)${q ? `&${q}` : ""}&order=created_at.desc&limit=300`
  );
  if (!r.ok) return jsonError(502, "Could not load orders.");
  const orders = (r.data ?? []).map(({ supply_order_lines: lines, ...o }) => ({
    ...o,
    line_count: lines.length,
    unit_count: lines.reduce((n, l) => n + l.qty, 0),
    estimated_cents: estimate(lines),
    awaiting_me: o.status === "pending_approval" && !!me && me === lc(o.approver_email)
  }));
  return json({ orders, can_order: canOrder(session) });
}

/** Sum of known prices; null when no line has one. */
export function estimate(lines: Array<{ qty: number; unit_price_cents: number | null }>): number | null {
  const priced = lines.filter((l) => l.unit_price_cents != null);
  if (priced.length === 0) return null;
  return priced.reduce((n, l) => n + l.qty * (l.unit_price_cents ?? 0), 0);
}

async function createOrder(request: Request, env: SupplyOrdersEnv, session: Session, ctx: ExecutionContext): Promise<Response> {
  if (!canOrder(session)) return jsonError(403, "Kleen-Rite ordering is not turned on for your login.");
  const body = await readJson(request);
  if (!body) return jsonError(400, "Could not read the order.");

  const locationId = Number(body.location_id);
  const member = await memberSites(env, session);
  const site = member.sites.find((s) => s.id === locationId);
  if (!site) return jsonError(400, "Pick one of your sites.");
  const initials = cleanInitials(body.initials);
  if (!initials) return jsonError(400, "Enter your initials for the PO.");
  const parsed = parseLines(body.lines);
  if ("error" in parsed) return jsonError(400, parsed.error);
  const vendor = await getVendor(env);
  if (!vendor) return jsonError(503, "Kleen-Rite ordering is not set up (supply_order_vendors).");

  const direct = canApproveFor(session, site);
  const approver = direct ? lc(session.email) : approverFor(site);
  if (!approver) return jsonError(400, `${siteLabel(site)} has no Regional Manager on file to approve this. Ask a super admin.`);

  const base = poBase(site.site_number, new Date(), initials);
  let created: OrderRow | null = null;
  // The unique index on po_number settles a race between two submits.
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const taken = await pg<Array<{ po_number: string }>>(
      env,
      "GET",
      `supply_orders?po_number=ilike.${encodeURIComponent(base)}*&select=po_number`
    );
    const po = nextPo(base, (taken.data ?? []).map((t) => t.po_number));
    const ins = await pg<OrderRow[]>(
      env,
      "POST",
      "supply_orders",
      {
        vendor: VENDOR,
        location_id: site.id,
        site_number: site.site_number,
        site_name: site.site ?? siteLabel(site),
        po_number: po,
        status: "pending_approval",
        ordered_by_email: lc(session.email),
        orderer_initials: initials,
        note: note(body, "note"),
        approver_email: approver,
        account_no: vendor.account_no,
        ship_to: shipToFor(site, vendor.ship_to_company),
        shipping_method: vendor.shipping_method
      },
      { Prefer: "return=representation" }
    );
    if (ins.ok) created = ins.data?.[0] ?? null;
    else if (ins.status !== 409) return jsonError(502, "Could not save the order.");
  }
  if (!created) return jsonError(502, "Could not assign a PO number. Try again.");

  const lineRows = parsed.lines.map((l, i) => ({ ...l, order_id: created!.id, line_no: i + 1 }));
  const li = await pg(env, "POST", "supply_order_lines", lineRows);
  if (!li.ok) {
    await pg(env, "DELETE", `supply_orders?id=eq.${created.id}`);
    return jsonError(502, "Could not save the order's items.");
  }
  await addEvent(env, created.id, "created", lc(session.email), created.note, {
    lines: lineRows.length,
    direct
  });

  if (direct) {
    const sent = await approveAndSend(env, session, created, site, vendor, [], null, ctx);
    if (!sent.ok) {
      return json({ id: created.id, po_number: created.po_number, status: "pending_approval", send_error: sent.error }, 201);
    }
    return json({ id: created.id, po_number: created.po_number, status: "sent" }, 201);
  }

  const lines = await getLines(env, created.id);
  ctx.waitUntil(
    sendApprovalRequestEmail(env, created, lines, site).catch((err) =>
      console.error("[supply-orders] approval email failed:", err)
    )
  );
  return json({ id: created.id, po_number: created.po_number, status: created.status }, 201);
}

async function orderDetail(env: SupplyOrdersEnv, session: Session, order: OrderRow, site: SiteRow | null): Promise<Response> {
  const [lines, events, vendor] = await Promise.all([getLines(env, order.id), getEvents(env, order.id), getVendor(env)]);
  const me = lc(session.email);
  const pending = order.status === "pending_approval";
  const canApprove = pending && (me === lc(order.approver_email) || (site ? canApproveFor(session, site) : isAdminTier(session)));
  const preview = vendor
    ? buildVendorEmail({ order, lines, vendor, test: !liveMode(env) })
    : null;
  return json({
    order,
    lines,
    events,
    estimated_cents: estimate(lines),
    can_approve: canApprove,
    can_cancel: pending && (me === lc(order.ordered_by_email) || isAdminTier(session)),
    live: liveMode(env),
    vendor_preview: preview ? { subject: preview.subject, text: preview.text } : null,
    vendor_to: vendor?.order_email ?? null
  });
}

async function approve(
  env: SupplyOrdersEnv,
  session: Session,
  order: OrderRow,
  site: SiteRow | null,
  body: Body,
  ctx: ExecutionContext
): Promise<Response> {
  if (order.status !== "pending_approval") return jsonError(409, `This order is already ${order.status.replace("_", " ")}.`);
  const me = lc(session.email);
  if (!(me === lc(order.approver_email) || (site && canApproveFor(session, site)))) {
    return jsonError(403, "Only the site's Regional Manager can approve this order.");
  }
  if (!site) return jsonError(409, "This order's site no longer exists.");
  const vendor = await getVendor(env);
  if (!vendor) return jsonError(503, "Kleen-Rite ordering is not set up (supply_order_vendors).");
  const lines = await getLines(env, order.id);
  const edits = applyQtyEdits(lines, body.lines);
  if ("error" in edits) return jsonError(400, edits.error);

  const r = await approveAndSend(env, session, order, site, vendor, edits.changes, note(body, "note"), ctx);
  if (!r.ok) return jsonError(502, r.error);
  return json({ ok: true, status: "sent", po_number: order.po_number });
}

/**
 * The one way an order leaves. Applies the approver's quantity edits, queues
 * the vendor email, and only then marks the order sent -- so a failed queue
 * leaves it pending and "Approve" can simply be pressed again.
 */
async function approveAndSend(
  env: SupplyOrdersEnv,
  session: Session,
  order: OrderRow,
  site: SiteRow,
  vendor: VendorRow,
  changes: Array<{ line_no: number; sku: string; from: number; to: number }>,
  decisionNote: string | null,
  ctx: ExecutionContext
): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = lc(session.email);
  if (changes.length) {
    for (const c of changes) {
      const path = `supply_order_lines?order_id=eq.${order.id}&line_no=eq.${c.line_no}`;
      const w = c.to === 0 ? await pg(env, "DELETE", path) : await pg(env, "PATCH", path, { qty: c.to });
      if (!w.ok) return { ok: false, error: "Could not save the quantity changes." };
    }
    await addEvent(env, order.id, "edited", me, null, { changes });
  }
  const lines = await getLines(env, order.id);
  const live = liveMode(env);
  const email = buildVendorEmail({ order, lines, vendor, test: !live });
  const replyTo = approverFor(site) ?? me;
  const to = live ? vendor.order_email : lc(env.SUPPLY_ORDERS_TEST_TO) || me;
  const cc = live && site.site_email ? [lc(site.site_email)] : [];

  try {
    await enqueueOutboundEmail(env, {
      source_worker: "workorders-worker",
      source_kind: "supply-order-vendor",
      source_id: order.id,
      recipient: to,
      cc,
      reply_to: replyTo,
      subject: email.subject,
      body_html: email.html,
      body_text: email.text,
      attachments: []
    });
  } catch (err) {
    console.error(`[supply-orders] vendor email enqueue failed for ${order.po_number}:`, err);
    await addEvent(env, order.id, "send_failed", me, null, { error: String(err).slice(0, 300) });
    return { ok: false, error: "The order was approved but the email to Kleen-Rite could not be queued. Press Approve again." };
  }

  const now = new Date().toISOString();
  const updated = await patchOrder(
    env,
    order.id,
    {
      status: "sent",
      decided_by_email: me,
      decided_at: now,
      decision_note: decisionNote,
      vendor_email_to: to,
      vendor_email_cc: cc,
      vendor_reply_to: replyTo,
      sent_at: now
    },
    "&status=eq.pending_approval"
  );
  const direct = me === lc(order.ordered_by_email);
  await addEvent(env, order.id, direct ? "sent" : "approved", me, decisionNote, { to, cc, test: !live });

  if (updated && !direct) {
    ctx.waitUntil(
      sendDecisionEmail(env, updated, lines, "approved").catch((err) =>
        console.error("[supply-orders] decision email failed:", err)
      )
    );
  }
  return { ok: true };
}

async function deny(
  env: SupplyOrdersEnv,
  session: Session,
  order: OrderRow,
  site: SiteRow | null,
  body: Body,
  ctx: ExecutionContext
): Promise<Response> {
  if (order.status !== "pending_approval") return jsonError(409, `This order is already ${order.status.replace("_", " ")}.`);
  const me = lc(session.email);
  if (!(me === lc(order.approver_email) || (site && canApproveFor(session, site)))) {
    return jsonError(403, "Only the site's Regional Manager can deny this order.");
  }
  const reason = note(body, "note");
  if (!reason) return jsonError(400, "Say why, so the GM knows what to change.");
  const updated = await patchOrder(
    env,
    order.id,
    { status: "denied", decided_by_email: me, decided_at: new Date().toISOString(), decision_note: reason },
    "&status=eq.pending_approval"
  );
  if (!updated) return jsonError(409, "This order changed while you were looking at it. Reload.");
  await addEvent(env, order.id, "denied", me, reason);
  const lines = await getLines(env, order.id);
  ctx.waitUntil(
    sendDecisionEmail(env, updated, lines, "denied").catch((err) => console.error("[supply-orders] decision email failed:", err))
  );
  return json({ ok: true, status: "denied" });
}

async function cancel(env: SupplyOrdersEnv, session: Session, order: OrderRow): Promise<Response> {
  if (order.status !== "pending_approval") return jsonError(409, `This order is already ${order.status.replace("_", " ")}.`);
  const me = lc(session.email);
  if (!(me === lc(order.ordered_by_email) || isAdminTier(session))) {
    return jsonError(403, "Only the person who placed this order can cancel it.");
  }
  const updated = await patchOrder(env, order.id, { status: "cancelled" }, "&status=eq.pending_approval");
  if (!updated) return jsonError(409, "This order changed while you were looking at it. Reload.");
  await addEvent(env, order.id, "cancelled", me);
  return json({ ok: true, status: "cancelled" });
}
