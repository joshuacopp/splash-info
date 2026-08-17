// Data layer for the inventory worker.
//
// This is the server-side half of what the standalone SPA used to do in its own
// src/lib/data.js (the Supabase branch). It reads the RAW `inventory`-schema
// tables and returns them in the exact JSON shape the SPA's calc.js + pages
// already expect — with ONE translation: the DB scopes everything on a
// `location_code` TEXT column, but the SPA speaks `location_id` (a leftover of
// its old uuid locations table). So on the way OUT we rename location_code ->
// location_id, and on the way IN we rename location_id -> location_code. That
// single rename lets ~11 page files keep working unchanged.
//
// Location list: the SPA wants a `locations` table; we synthesize it from
// pricing_simple (location_code -> id, location_pretty -> name) UNIONED with
// the inventory.locations overlay (see overlay.ts), with manager/region read
// off public.locations by site number. Overlay rows inherit manager/region
// from their parent_code, so an in-bay sits under the same area manager as its
// tunnel.
//
// Scope: super_admin sees everything; everyone else is filtered to
// session.locations (their granted location_codes) — already expanded with
// overlay children by inventoryGate, so nothing here needs to know about
// parent_code.

import type { SupabaseClient } from "@splash/db-supabase";
import { enqueueOutboundEmail } from "@splash/db-supabase";
import type { Session } from "@splash/types/session";
// (userCanAccessLocation used to be imported here and never called — dropped
// with the overlay change so the module graph is db -> overlay only.)
import { loadOverlay } from "./overlay.js";
import { renderVisitReport } from "./report-email.js";
import type { ComputedVisitLike } from "./report-email.js";
// Imported, not reimplemented. calc.js is the same module the Visit Detail
// page renders from, so the email cannot disagree with the screen. See the
// allowJs note in tsconfig.json for why the worker can reach into src/.
import { attachPrevDeltas, buildIndex, computeVisit } from "../src/lib/calc.js";

const SCHEMA = "inventory";
const inv = (sb: SupabaseClient) => sb.schema(SCHEMA);

function newId(): string {
  return crypto.randomUUID();
}

/** Rename a `location_code` column to `location_id` on every row (DB -> SPA). */
function codeToId<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => {
    const { location_code, ...rest } = r as Record<string, unknown>;
    return { ...rest, location_id: location_code } as unknown as T;
  });
}

/** Lower-cased set of the session's granted codes; null means "unrestricted". */
function allowedCodes(session: Session): Set<string> | null {
  if (session.role === "super_admin") return null;
  return new Set(session.locations.map((l) => l.toLowerCase()));
}

function inScope(allowed: Set<string> | null, code: unknown): boolean {
  if (allowed === null) return true;
  return typeof code === "string" && allowed.has(code.toLowerCase());
}

// ---------------------------------------------------------------------------
// Location list (pricing_simple ∪ inventory.locations overlay)
//
// pricing_simple is one row PER PACKAGE, so it needs deduping on
// location_code. The overlay is already one row per location. pricing_simple
// wins on a collision — it is the platform's registry and the overlay is only
// ever meant to carry codes it doesn't have (verify #3 in
// supabase/inventory-locations-overlay.sql checks for exactly this).
// ---------------------------------------------------------------------------
// `active` is carried, not assumed: an overlay row for a sold or closed site
// (buckley_4s) stays in the list so its history is still reachable, and the SPA
// hides it from the sidebar and the company rollups off this flag.
// pricing_simple has no equivalent column, so its rows are always active.
//
// manager/region drive the sidebar: Layout.jsx groups by `manager` and prints
// `region` as the group's subtitle, falling back to a single "Unassigned"
// group when both are null.
//
// `manager` is the area manager. `region` is the regional manager's NAME —
// rm_group is an integer 1-9 with no lookup table anywhere, so "Region 7" tells
// a reader nothing. The number rides along in a SEPARATE `region_group` field
// and is never baked into `region`, because `region` is a grouping key in the
// sidebar: a site missing its registry row has no rm_group, and if the number
// were part of the string that site would split off into its own "Earl Budlong"
// group next to "Earl Budlong (8)". Display detail, not identity.
//
// rm_group only exists on public.locations, so this reads the registry as well
// as pricing_simple and joins them on site number. pricing_simple.site is that
// number as ZERO-PADDED text ("019"), denormalized by trg_sync_pricing_simple,
// against an integer site_number — see siteKey() below, which is the whole
// reason that helper exists. site_number is not unique — 19/40/68 each carry
// two rows, Express vs Handwash — but the pair share an org chart, so
// first-wins is fine for a label. Anything that doesn't join falls back to
// pricing_simple's own denormalized manager columns.
interface LocationMeta {
  name: string;
  manager: string | null;
  region: string | null;
  region_group: string | null;
}

function locationRow(id: string, meta: LocationMeta, active: boolean): Record<string, unknown> {
  return {
    id,
    name: meta.name,
    active,
    manager: meta.manager,
    region: meta.region,
    region_group: meta.region_group
  };
}

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Site-number join key. public.locations.site_number is an INTEGER but
// pricing_simple.site is TEXT and ZERO-PADDED ("019", "083"), so a naive
// String(site_number) === site comparison misses every site under 100 — 32
// codes, most of the CT/Westchester portfolio. Normalise both sides through
// parseInt so "019", "19" and 19 all key the same.
function siteKey(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : null;
  if (typeof v !== "string") return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? String(n) : null;
}

// rm_group is an INTEGER column in Postgres (packages/types types it
// `string | null`, which is wrong — see locations.ts:25), so str() would drop
// it. Read it defensively either way in case the column is ever widened.
function rmGroup(row: Record<string, unknown>): string | null {
  const v = row.rm_group;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(row, "rm_group");
}

/** Name if there is one, else "Region 7" so the row still lands somewhere. */
function regionLabel(row: Record<string, unknown>): string | null {
  const name = str(row, "regional_manager");
  if (name) return name;
  const group = rmGroup(row);
  return group ? `Region ${group}` : null;
}

async function getLocations(sb: SupabaseClient, allowed: Set<string> | null) {
  const [pricing, registry, overlay] = await Promise.all([
    sb
      .from("pricing_simple")
      .select("location_code,location_pretty,site,area_manager,regional_manager"),
    sb.from("locations").select("site_number,area_manager,regional_manager,rm_group"),
    loadOverlay(sb)
  ]);
  if (pricing.error) throw new Error(`Failed loading locations: ${pricing.error.message}`);

  // Registry lookup by site number, keyed as a string because pricing_simple
  // carries it as text. Fail-soft like the overlay: if this read fails the
  // sidebar loses its region subtitles, which is not worth a 500 when the
  // fallback below still produces a usable grouping.
  const bySite = new Map<
    string,
    { manager: string | null; region: string | null; region_group: string | null }
  >();
  if (registry.error) {
    console.error("[inventory.locations] registry read failed", registry.error.message);
  } else {
    for (const raw of registry.data || []) {
      const row = raw as Record<string, unknown>;
      const key = siteKey(row.site_number);
      if (!key || bySite.has(key)) continue;
      bySite.set(key, {
        manager: str(row, "area_manager"),
        region: regionLabel(row),
        region_group: rmGroup(row)
      });
    }
  }

  // First pass builds meta for EVERY pricing code, in scope or not: an overlay
  // child inherits its parent's manager/region, and the parent can be out of
  // scope when somebody is granted an overlay code directly rather than
  // through parent_code.
  const meta = new Map<string, LocationMeta>();
  const order: string[] = [];
  for (const raw of pricing.data || []) {
    const row = raw as Record<string, unknown>;
    const code = str(row, "location_code");
    if (!code || meta.has(code)) continue;
    const site = siteKey(row.site);
    const reg = site ? bySite.get(site) : undefined;
    meta.set(code, {
      name: str(row, "location_pretty") || code,
      manager: reg?.manager || str(row, "area_manager"),
      region: reg?.region || str(row, "regional_manager"),
      region_group: reg?.region_group ?? null
    });
    order.push(code);
  }

  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const code of order) {
    if (!inScope(allowed, code)) continue;
    seen.add(code);
    out.push(locationRow(code, meta.get(code)!, true));
  }

  for (const row of overlay) {
    if (seen.has(row.code)) continue;
    if (!inScope(allowed, row.code)) continue;
    seen.add(row.code);
    const parent = row.parent_code ? meta.get(row.parent_code.trim().toLowerCase()) : undefined;
    out.push(
      locationRow(
        row.code,
        {
          name: row.name || row.code,
          manager: parent?.manager ?? null,
          region: parent?.region ?? null,
          region_group: parent?.region_group ?? null
        },
        row.active !== false
      )
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// loadData() equivalent — the full dataset, scoped + translated.
// ---------------------------------------------------------------------------
export async function loadInventoryData(sb: SupabaseClient, session: Session) {
  const allowed = allowedCodes(session);

  const [
    locations,
    products,
    locationProducts,
    packages,
    packageProducts,
    siteVisits,
    inventoryEntries,
    washCounts,
    recipients,
    recipientLocations,
    flagResolutions
  ] = await Promise.all([
    getLocations(sb, allowed),
    selectAll(sb, "products"),
    selectAll(sb, "location_products"),
    selectAll(sb, "packages"),
    selectAll(sb, "package_products"),
    selectAll(sb, "site_visits"),
    selectAll(sb, "inventory_entries"),
    selectAll(sb, "wash_counts"),
    selectAll(sb, "notification_recipients"),
    selectAll(sb, "notification_recipient_locations"),
    selectAll(sb, "flag_resolutions")
  ]);

  // Scope the location-keyed tables, then rename location_code -> location_id.
  const scopedLocProducts = locationProducts.filter((r) => inScope(allowed, r.location_code));
  const scopedPackages = packages.filter((r) => inScope(allowed, r.location_code));
  const scopedVisits = siteVisits.filter((r) => inScope(allowed, r.location_code));
  const scopedFlags = flagResolutions.filter((r) => inScope(allowed, r.location_code));
  const scopedRecipientLocations = recipientLocations.filter((r) =>
    inScope(allowed, r.location_code)
  );

  // Children scope off their parents.
  const visibleVisitIds = new Set(scopedVisits.map((v) => v.id as string));
  const visiblePkgIds = new Set(scopedPackages.map((p) => p.id as string));
  const scopedEntries = inventoryEntries.filter((e) =>
    visibleVisitIds.has(e.site_visit_id as string)
  );
  const scopedWashCounts = washCounts.filter((w) =>
    visibleVisitIds.has(w.site_visit_id as string)
  );
  const scopedPackageProducts = packageProducts.filter((pp) =>
    visiblePkgIds.has(pp.package_id as string)
  );

  return {
    locations,
    products,
    location_products: codeToId(scopedLocProducts),
    packages: codeToId(scopedPackages),
    package_products: scopedPackageProducts,
    site_visits: codeToId(scopedVisits),
    inventory_entries: scopedEntries,
    wash_counts: scopedWashCounts,
    notification_recipients: recipients,
    notification_recipient_locations: codeToId(scopedRecipientLocations),
    flag_resolutions: codeToId(scopedFlags),
    // Obsolete tables — users/roles now come from splash sysadmin, not here.
    user_profiles: [],
    user_locations: []
  };
}

// PostgREST caps every response at `db-max-rows` (1000 on Supabase) and does
// NOT report the truncation — it just returns fewer rows with a 200. A bare
// .select("*") was therefore correct only while the tables were small. After
// the 2026-08-17 history import (22,715 inventory_entries, 8,317 wash_counts,
// 3,172 package_products, 1,628 site_visits) it silently returned the first
// 1,000 of each, so every location past the first handful rendered its visits
// with wash count 0, chemical cost $0.00 and a blank CPC — real rows, invisible.
//
// Paginate on `count: "exact"` rather than on "short page means done": if the
// server's cap is ever lower than PAGE, a short first page is not the end of
// the table and the loop would stop early with the same silent truncation.
//
// .range() without a deterministic sort can repeat or skip rows across pages,
// so every call orders by its key. Most tables key on `id`;
// notification_recipient_locations has a composite PK and no id column.
const PAGE = 1000;
const ORDER_KEY: Record<string, string[]> = {
  notification_recipient_locations: ["recipient_id", "location_code"]
};

async function selectAll(sb: SupabaseClient, table: string): Promise<Array<Record<string, unknown>>> {
  const keys = ORDER_KEY[table] ?? ["id"];
  const out: Array<Record<string, unknown>> = [];
  let total: number | null = null;

  for (let page = 0; ; page += 1) {
    if (page > 500) {
      throw new Error(`Failed loading ${table}: pagination did not terminate`);
    }
    let q = inv(sb).from(table).select("*", { count: "exact" });
    for (const k of keys) q = q.order(k, { ascending: true });
    const { data, error, count } = await q.range(out.length, out.length + PAGE - 1);
    if (error) throw new Error(`Failed loading ${table}: ${error.message}`);
    if (total === null && typeof count === "number") total = count;

    const rows = (data || []) as Array<Record<string, unknown>>;
    out.push(...rows);
    if (rows.length === 0) break;
    if (total !== null && out.length >= total) break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------
function mapEntryRow(e: Record<string, unknown>, visitId: string) {
  const num = (v: unknown) => Number(v) || 0;
  const nullableNum = (v: unknown) => (v == null || v === "" ? null : Number(v) || 0);
  return {
    id: newId(),
    site_visit_id: visitId,
    product_id: e.product_id,
    starting_qty_gal: num(e.starting_qty_gal),
    qty_delivered_gal: num(e.qty_delivered_gal),
    reservoir_count_gal: e.reservoir_count_gal == null ? null : num(e.reservoir_count_gal),
    floor_count_gal: e.floor_count_gal == null ? null : num(e.floor_count_gal),
    ending_qty_gal: num(e.ending_qty_gal),
    discount: num(e.discount),
    metering_type: e.metering_type || null,
    tip_color: e.tip_color || null,
    versadial_number: nullableNum(e.versadial_number),
    injector_color: e.injector_color || null,
    injector_gpm: nullableNum(e.injector_gpm)
  };
}

function mapWashCounts(list: unknown, visitId: string) {
  return ((list as Array<Record<string, unknown>>) || [])
    .filter((w) => w.package_id)
    .map((w) => ({
      id: newId(),
      site_visit_id: visitId,
      package_id: w.package_id,
      wash_count: Math.round(Number(w.wash_count) || 0)
    }));
}

// Water readings arrive as strings from the form. `|| 0` is deliberately NOT
// used here the way it is for gallons: a blank box must land as NULL ("not
// recorded"), never as 0, because 0 gpg is a real reading at an RO or softened
// site and the two must stay distinguishable in the history.
const reading = (v: unknown) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** payload: { location_id, visit_date, submitter, notes, water_hardness_gpg, tds_ppm, entries[], washCounts[] } */
export async function createVisit(sb: SupabaseClient, payload: Record<string, unknown>) {
  const visitId = newId();
  const visit = {
    id: visitId,
    location_code: payload.location_id, // SPA sends the code in location_id
    visit_date: payload.visit_date,
    submitter: payload.submitter || null,
    notes: payload.notes || null,
    water_hardness_gpg: reading(payload.water_hardness_gpg),
    tds_ppm: reading(payload.tds_ppm)
  };
  const entries = ((payload.entries as Array<Record<string, unknown>>) || []).map((e) =>
    mapEntryRow(e, visitId)
  );
  const washCounts = mapWashCounts(payload.washCounts, visitId);

  const { error: vErr } = await inv(sb).from("site_visits").insert(visit);
  if (vErr) throw new Error(vErr.message);
  if (entries.length) {
    const { error } = await inv(sb).from("inventory_entries").insert(entries);
    if (error) throw new Error(error.message);
  }
  if (washCounts.length) {
    const { error } = await inv(sb).from("wash_counts").insert(washCounts);
    if (error) throw new Error(error.message);
  }
  return { visitId };
}

/** Replaces a visit's own fields plus its full set of entries/wash_counts. */
export async function updateVisit(
  sb: SupabaseClient,
  visitId: string,
  payload: Record<string, unknown>
) {
  const visitPatch = {
    visit_date: payload.visit_date,
    submitter: payload.submitter || null,
    notes: payload.notes || null,
    water_hardness_gpg: reading(payload.water_hardness_gpg),
    tds_ppm: reading(payload.tds_ppm)
  };
  const entries = ((payload.entries as Array<Record<string, unknown>>) || []).map((e) =>
    mapEntryRow(e, visitId)
  );
  const washCounts = mapWashCounts(payload.washCounts, visitId);

  const { error: vErr } = await inv(sb).from("site_visits").update(visitPatch).eq("id", visitId);
  if (vErr) throw new Error(vErr.message);
  const { error: delE } = await inv(sb).from("inventory_entries").delete().eq("site_visit_id", visitId);
  if (delE) throw new Error(delE.message);
  const { error: delW } = await inv(sb).from("wash_counts").delete().eq("site_visit_id", visitId);
  if (delW) throw new Error(delW.message);
  if (entries.length) {
    const { error } = await inv(sb).from("inventory_entries").insert(entries);
    if (error) throw new Error(error.message);
  }
  if (washCounts.length) {
    const { error } = await inv(sb).from("wash_counts").insert(washCounts);
    if (error) throw new Error(error.message);
  }
  return { visitId };
}

export async function deleteVisit(sb: SupabaseClient, visitId: string) {
  const { error } = await inv(sb).from("site_visits").delete().eq("id", visitId);
  if (error) throw new Error(error.message);
}

/** Returns the location_code a visit belongs to (for scope-checking edits). */
export async function getVisitLocationCode(
  sb: SupabaseClient,
  visitId: string
): Promise<string | null> {
  const { data, error } = await inv(sb)
    .from("site_visits")
    .select("location_code")
    .eq("id", visitId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.location_code as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export async function upsertProduct(sb: SupabaseClient, product: Record<string, unknown>) {
  const row = {
    id: product.id || newId(),
    name: String(product.name || "").trim(),
    price_per_ml: Number(product.price_per_ml) || 0,
    unit_type: product.unit_type ? String(product.unit_type).trim() : null,
    description: product.description ? String(product.description).trim() : null
  };
  if (!row.name) throw new Error("Product name is required");
  const { error } = await inv(sb).from("products").upsert(row);
  if (error) throw new Error(error.message);
  return row;
}

// ---------------------------------------------------------------------------
// Package configuration (per location)
// payload: { packages:[{id?,name,isNew?,deleted?,packageType}],
//            locationProducts:[{id?,product_id,target_ml_per_car,discount,deleted?}],
//            matrix:{[pkgId]:{[productId]:uses}} }
// ---------------------------------------------------------------------------
export async function savePackageConfig(
  sb: SupabaseClient,
  locationCode: string,
  payload: Record<string, unknown>
) {
  const pkgRows: Array<Record<string, unknown>> = [];
  const idMap: Record<string, string> = {};
  for (const p of (payload.packages as Array<Record<string, unknown>>) || []) {
    if (p.deleted) continue;
    const realId = p.isNew ? newId() : (p.id as string);
    idMap[p.id as string] = realId;
    pkgRows.push({
      id: realId,
      location_code: locationCode,
      name: String(p.name).trim(),
      package_type: p.packageType === "addon" ? "addon" : "wash",
      target_cpc: null
    });
  }
  const lpRows: Array<Record<string, unknown>> = [];
  for (const lp of (payload.locationProducts as Array<Record<string, unknown>>) || []) {
    if (lp.deleted) continue;
    lpRows.push({
      id: lp.id || newId(),
      location_code: locationCode,
      product_id: lp.product_id,
      target_ml_per_car:
        lp.target_ml_per_car == null || lp.target_ml_per_car === ""
          ? null
          : Number(lp.target_ml_per_car),
      discount: Number(lp.discount) || 0
    });
  }
  const activeProductIds = new Set(lpRows.map((r) => r.product_id));
  const ppRows: Array<Record<string, unknown>> = [];
  const matrix = (payload.matrix as Record<string, Record<string, unknown>>) || {};
  for (const [pkgId, products] of Object.entries(matrix)) {
    const realPkg = idMap[pkgId];
    if (!realPkg) continue;
    for (const [productId, uses] of Object.entries(products)) {
      const u = Number(uses);
      if (!u || u <= 0 || !activeProductIds.has(productId)) continue;
      ppRows.push({ id: newId(), package_id: realPkg, product_id: productId, uses: u });
    }
  }

  // Replace this location's config. Upsert kept packages, delete orphans (FK
  // restrict guards packages that already have wash_count history).
  const { data: existingPkgs, error: exErr } = await inv(sb)
    .from("packages")
    .select("id")
    .eq("location_code", locationCode);
  if (exErr) throw new Error(exErr.message);
  const keptIds = new Set(pkgRows.map((r) => r.id as string));
  const toDelete = ((existingPkgs || []) as Array<Record<string, unknown>>)
    .map((r) => r.id as string)
    .filter((id) => !keptIds.has(id));

  const { error: upErr } = await inv(sb).from("packages").upsert(pkgRows);
  if (upErr) throw new Error(upErr.message);
  if (toDelete.length) {
    const { error: delErr } = await inv(sb).from("packages").delete().in("id", toDelete);
    if (delErr)
      throw new Error(`Could not delete package(s) with recorded history: ${delErr.message}`);
  }
  const allPkgIds = pkgRows.map((r) => r.id as string);
  if (allPkgIds.length) {
    const { error: wipeErr } = await inv(sb)
      .from("package_products")
      .delete()
      .in("package_id", allPkgIds);
    if (wipeErr) throw new Error(wipeErr.message);
  }
  if (ppRows.length) {
    const { error: ppErr } = await inv(sb).from("package_products").insert(ppRows);
    if (ppErr) throw new Error(ppErr.message);
  }
  const { error: lpWipeErr } = await inv(sb)
    .from("location_products")
    .delete()
    .eq("location_code", locationCode);
  if (lpWipeErr) throw new Error(lpWipeErr.message);
  if (lpRows.length) {
    const { error: lpErr } = await inv(sb).from("location_products").insert(lpRows);
    if (lpErr) throw new Error(lpErr.message);
  }
  return { packages: pkgRows.length, products: lpRows.length };
}

// ---------------------------------------------------------------------------
// Email recipients (super_admin)
// list items: { id?, email, name, active, deleted, allLocations, locationIds[] }
// ---------------------------------------------------------------------------
export async function saveRecipients(sb: SupabaseClient, list: Array<Record<string, unknown>>) {
  const rows = list
    .filter((r) => !r.deleted && String(r.email || "").trim())
    .map((r) => ({
      id: (r.id as string) || newId(),
      email: String(r.email).trim().toLowerCase(),
      name: r.name ? String(r.name).trim() : null,
      active: r.active !== false,
      all_locations: r.allLocations !== false,
      _locationIds: r.allLocations === false ? (r.locationIds as string[]) || [] : []
    }));
  const recipientLocationRows = rows.flatMap((r) =>
    r._locationIds.map((code) => ({ recipient_id: r.id, location_code: code }))
  );
  const cleanRows = rows.map(({ _locationIds, ...rest }) => rest);

  const { data: existing, error: exErr } = await inv(sb)
    .from("notification_recipients")
    .select("id");
  if (exErr) throw new Error(exErr.message);
  const keep = new Set(cleanRows.map((r) => r.id));
  const toDelete = ((existing || []) as Array<Record<string, unknown>>)
    .map((r) => r.id as string)
    .filter((id) => !keep.has(id));
  if (cleanRows.length) {
    const { error } = await inv(sb).from("notification_recipients").upsert(cleanRows);
    if (error) throw new Error(error.message);
  }
  if (toDelete.length) {
    const { error } = await inv(sb).from("notification_recipients").delete().in("id", toDelete);
    if (error) throw new Error(error.message);
  }
  if (cleanRows.length) {
    const { error: wipeErr } = await inv(sb)
      .from("notification_recipient_locations")
      .delete()
      .in(
        "recipient_id",
        cleanRows.map((r) => r.id)
      );
    if (wipeErr) throw new Error(wipeErr.message);
  }
  if (recipientLocationRows.length) {
    const { error: insErr } = await inv(sb)
      .from("notification_recipient_locations")
      .insert(recipientLocationRows);
    if (insErr) throw new Error(insErr.message);
  }
  // Return in the SPA's shape (allLocations + locationIds, code as location_id).
  return cleanRows.map((r) => ({
    ...r,
    allLocations: r.all_locations,
    locationIds: recipientLocationRows
      .filter((x) => x.recipient_id === r.id)
      .map((x) => x.location_code)
  }));
}

// ---------------------------------------------------------------------------
// Visit report
//
// Enqueues onto the shared `outbound_emails` queue that Power Automate drains,
// the same path forms-worker and promo-worker use. Inventory does not talk to
// an email provider itself: one PA flow already owns delivery, retries, and the
// admin email-queue view at /admin/email-queue, and standing up a second sender
// would mean a second set of DNS/SPF surprises for no new capability.
//
// One queue row per recipient, which is what the dedup index on
// (source_worker, source_kind, source_id, recipient) expects. `source_id` is
// the site_visits UUID, so a double-tapped Submit or a retried request
// re-enqueues nothing — and once PA has stamped sent_at, it never re-sends.
// ---------------------------------------------------------------------------

export interface ReportRecipient {
  email: string;
  name: string | null;
  /** Where this address came from — surfaced in the Admin list and the logs. */
  via: "site" | "rm" | "configured";
}

/**
 * The site and regional-manager addresses for `locationCode`, straight off the
 * platform registry.
 *
 * These are DERIVED, not administered: nobody maintains a list, so an RM
 * handoff or a corrected site mailbox propagates to the reports the moment
 * pricing_simple changes. That is the whole point — an email list that has to
 * be hand-edited after a personnel change is an email list that goes stale.
 *
 * Overlay locations (IBAs, lubes) have no pricing_simple row of their own, so
 * they resolve through `parent_code` exactly as manager/region already do in
 * getLocations. An IBA's report goes to the tunnel's site mailbox and RM.
 *
 * Fail-soft throughout. A registry read that errors costs the derived
 * addresses; it must not cost the configured ones, and it must not 500 a
 * request whose visit is already saved.
 */
async function resolveDerivedEmails(
  sb: SupabaseClient,
  locationCode: string
): Promise<ReportRecipient[]> {
  const code = locationCode.trim().toLowerCase();

  // Resolve through the overlay first so a child code asks the registry about
  // its parent rather than about a code the registry has never heard of.
  let effective = code;
  try {
    const overlay = await loadOverlay(sb);
    const row = overlay.find((o) => o.code === code);
    const parent = row?.parent_code?.trim().toLowerCase();
    if (parent) effective = parent;
  } catch (err) {
    console.error("[inventory.report] overlay lookup failed; using code as-is", err);
  }

  const { data, error } = await sb
    .from("pricing_simple")
    .select("site_email,rm_email")
    .eq("location_code", effective)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[inventory.report] registry email read failed", error.message);
    return [];
  }

  const row = (data || {}) as Record<string, unknown>;
  const out: ReportRecipient[] = [];
  const site = String(row.site_email || "").trim().toLowerCase();
  const rm = String(row.rm_email || "").trim().toLowerCase();
  if (site.includes("@")) out.push({ email: site, name: null, via: "site" });
  if (rm.includes("@")) out.push({ email: rm, name: null, via: "rm" });
  return out;
}

/**
 * Everyone who should receive the report for `locationCode`.
 *
 * Two independent sources, unioned and deduped by lowercased address:
 *
 *   DERIVED    — site_email + rm_email off the registry (resolveDerivedEmails).
 *                Automatic, unadministered, follows the org chart.
 *   CONFIGURED — inventory.notification_recipients. `all_locations = true`
 *                (every visit everywhere: vendor reps, ops) or `false` plus an
 *                explicit notification_recipient_locations row (a GM at two
 *                specific stores). This is how anyone outside the location
 *                tables gets added, and it needs no schema change to do it.
 *
 * SUPPRESSION reuses `active = false` rather than adding a column. A recipients
 * row marked inactive means "never mail this address", and that now applies to
 * derived addresses too — so a wrong site mailbox or an RM who doesn't want
 * thirty of these a month is fixed by adding one inactive row, in the same
 * table and the same admin screen used for adding people. One place a human
 * edits, whether they are adding or subtracting.
 *
 * Deliberately NOT filtered by the sender's own scope. A recipient list is an
 * admin-configured distribution list, not a permission — the area manager who
 * should hear about every site in their region is entitled to that email
 * whether or not the tech who filed the visit can see the rest of the region.
 */
async function resolveReportRecipients(
  sb: SupabaseClient,
  locationCode: string
): Promise<ReportRecipient[]> {
  const code = locationCode.trim().toLowerCase();

  const [people, links, derived] = await Promise.all([
    inv(sb).from("notification_recipients").select("id,email,name,active,all_locations"),
    inv(sb).from("notification_recipient_locations").select("recipient_id,location_code"),
    resolveDerivedEmails(sb, code)
  ]);
  if (people.error) throw new Error(`Failed loading recipients: ${people.error.message}`);
  // A failed link read is NOT fatal, but it must not silently widen the send:
  // treating the scoped recipients as unscoped would mail every site's report
  // to someone who asked for one. Skip them and mail the all_locations people.
  if (links.error) {
    console.error("[inventory.report] recipient locations read failed", links.error.message);
  }

  const scoped = new Set<string>();
  for (const raw of (links.data || []) as Array<Record<string, unknown>>) {
    if (String(raw.location_code || "").trim().toLowerCase() === code) {
      scoped.add(String(raw.recipient_id || ""));
    }
  }

  // Suppressions are collected across the WHOLE recipients table, not just the
  // rows that qualify for this site. An inactive row is a statement about the
  // address itself ("never mail this"), so it has to outrank a derived address
  // that no list row would otherwise be scoped to.
  const suppressed = new Set<string>();
  const configured: ReportRecipient[] = [];
  for (const raw of (people.data || []) as Array<Record<string, unknown>>) {
    const email = String(raw.email || "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    if (raw.active === false) {
      suppressed.add(email);
      continue;
    }
    const qualifies = raw.all_locations !== false || scoped.has(String(raw.id || ""));
    if (!qualifies) continue;
    configured.push({ email, name: raw.name ? String(raw.name) : null, via: "configured" });
  }

  // Derived first so that when an address is in both sources it reports as
  // site/rm — the more useful answer when you're looking at the queue asking
  // "why did this person get mail". A configured row for the same address
  // still contributes its display name below.
  const byEmail = new Map<string, ReportRecipient>();
  for (const r of [...derived, ...configured]) {
    if (suppressed.has(r.email)) continue;
    const existing = byEmail.get(r.email);
    if (!existing) byEmail.set(r.email, r);
    else if (!existing.name && r.name) existing.name = r.name;
  }
  return [...byEmail.values()];
}

/**
 * Load the whole dataset with NO location scoping.
 *
 * The report is rendered from the visited site's own data, and the caller has
 * already been authorized against that site by the route (getVisitLocationCode
 * + userCanAccessLocation). Inheriting the caller's scope here would mean a
 * narrowly-scoped user's resend silently rendered an empty comparison rather
 * than being refused — a wrong report is worse than no report.
 */
function loadUnscoped(sb: SupabaseClient) {
  return loadInventoryData(sb, {
    role: "super_admin",
    email: "",
    locations: []
  } as unknown as Session);
}

export interface SendVisitReportOptions {
  visitId: string;
  /** Deliberate re-send; varies the dedup key. Route-gated to admins. */
  resend?: boolean;
}

export async function sendVisitReport(
  sb: SupabaseClient,
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  origin: string,
  opts: SendVisitReportOptions
) {
  const visitId = String(opts.visitId || "").trim();
  if (!visitId) throw new Error("report: visitId is required");

  // Everything in the email is recomputed here from stored rows — the request
  // body contributes nothing but the visit id. That is what keeps the email in
  // agreement with the Visit Detail page, and it is why a stale browser tab
  // POSTing the old fat payload still produces a correct report.
  const ds = await loadUnscoped(sb);
  const idx = buildIndex(ds);
  const computed = attachPrevDeltas(ds, idx, computeVisit(ds, idx, visitId));
  if (!computed) throw new Error("report: visit not found");

  const locationCode = String(computed.visit.location_id || "").trim();
  if (!locationCode) throw new Error("report: visit has no location");

  const recipients = await resolveReportRecipients(sb, locationCode);
  if (!recipients.length) {
    // Not an error. Plenty of sites have no recipient configured yet, and the
    // visit itself is already saved — the caller surfaces this as a note.
    return { queued: 0, duplicates: 0, recipients: [] as string[], flagCount: computed.flagCount };
  }

  // Built here, from the worker's own origin, so staging links stay on staging
  // and nothing in the request body can choose where the email points.
  const visitUrl = `${origin}/inventory/location/${encodeURIComponent(
    locationCode
  )}/visit/${encodeURIComponent(visitId)}`;

  // Cast because calc.js is untyped JS reached through allowJs, so `computed`
  // arrives here as `any`. ComputedVisitLike in report-email.ts is the
  // hand-written contract between the two, and this is where it's asserted.
  const { subject, bodyHtml, bodyText, attachment } = renderVisitReport(
    computed as ComputedVisitLike,
    visitUrl
  );

  // Automatic sends key on the visit id alone, which is what makes a
  // double-tapped Submit a no-op forever. A deliberate resend has to differ or
  // the queue would swallow it — but only down to the minute, so a
  // double-clicked Resend button is still absorbed.
  const sourceId = opts.resend ? `${visitId}:r${Math.floor(Date.now() / 60000)}` : visitId;

  let queued = 0;
  let duplicates = 0;
  const delivered: string[] = [];

  // Sequential, not Promise.all. This is at most a handful of rows, and one
  // failing recipient must not abort the others — a rejected Promise.all would
  // lose the successes it already had.
  for (const r of recipients) {
    try {
      const result = await enqueueOutboundEmail(env, {
        source_worker: "inventory",
        source_kind: "visit-report",
        source_id: sourceId,
        recipient: r.email,
        subject,
        body_html: bodyHtml,
        body_text: bodyText,
        // base64 rather than r2_key. The comparison sheet is tens of KB, and
        // an r2_key would mean widening the bucket union in @splash/db-supabase,
        // binding a new bucket on FORMS-worker's wrangler.toml, and extending
        // its claim-endpoint dispatch — three coordinated changes across two
        // workers to save a few KB per queue row.
        attachments: [attachment]
      });
      if (result.was_duplicate) duplicates++;
      else queued++;
      delivered.push(r.email);
    } catch (err) {
      console.error(`[inventory.report] enqueue failed for ${r.email}`, err);
    }
  }

  // `via` rides back so the toast can say "site, RM and 2 others" rather than
  // just a count, and so a surprising recipient is traceable without opening
  // the queue.
  return {
    queued,
    duplicates,
    recipients: delivered,
    via: recipients.map((r) => ({ email: r.email, via: r.via })),
    flagCount: computed.flagCount
  };
}

// ---------------------------------------------------------------------------
// Flag resolutions (Attention page)
// ---------------------------------------------------------------------------
export async function resolveFlag(
  sb: SupabaseClient,
  flagKey: string,
  resolvedBy: string,
  locationCode: string,
  note: string | null
) {
  const row = {
    id: newId(),
    flag_key: flagKey,
    location_code: locationCode,
    resolved_by: resolvedBy,
    note: note || null,
    resolved_at: new Date().toISOString()
  };
  const { error } = await inv(sb)
    .from("flag_resolutions")
    .upsert(row, { onConflict: "flag_key" });
  if (error) throw new Error(error.message);
  // Return in SPA shape (code as location_id).
  const { location_code, ...rest } = row;
  return { ...rest, location_id: location_code };
}

export async function unresolveFlag(sb: SupabaseClient, flagKey: string) {
  const { error } = await inv(sb).from("flag_resolutions").delete().eq("flag_key", flagKey);
  if (error) throw new Error(error.message);
}
