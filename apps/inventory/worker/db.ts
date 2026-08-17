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
import type { Session } from "@splash/types/session";
// (userCanAccessLocation used to be imported here and never called — dropped
// with the overlay change so the module graph is db -> overlay only.)
import { loadOverlay } from "./overlay.js";

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
// Visit report — forward to optional webhook, else fail soft (simulated).
// ---------------------------------------------------------------------------
export async function sendVisitReport(
  webhookUrl: string | undefined,
  payload: Record<string, unknown>
) {
  if (!webhookUrl) {
    return { simulated: true, sent: 0, recipients: [] as string[] };
  }
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Report webhook failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json().catch(() => ({ ok: true }));
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
