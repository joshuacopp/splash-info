// SDS binder index — per-site hazardous chemical list, read/write API.
//
//   GET   /forms/api/sds?location=            list + accessible sites + review stamp
//   POST  /forms/api/sds                      add one chemical by hand
//   PATCH /forms/api/sds/{id}                 edit, or set is_active
//   GET   /forms/api/sds/candidates?location= wash chemicals inventory knows about
//   POST  /forms/api/sds/seed                 add picked candidates to the list
//   POST  /forms/api/sds/review               stamp "reviewed today"
//
// AUTHORITY IS ../site-access.ts, the same email-on-locations answer the action
// items page runs on. Site contacts and RMs both EDIT -- there is no read-only
// tier here, because the person holding the binder is the person who knows what
// is in it. Every write re-reads the row's location_code and re-checks: an id
// says nothing about who owns it.
//
// WHAT THIS IS NOT. OSHA's HazCom standard (29 CFR 1910.1200) wants a written
// programme, training, labelling, accessible sheets AND a list of the hazardous
// chemicals present. This is the list, and it is only correct if
// `product_identifier` matches the identity on the actual sheet and label --
// which is why nothing here rewrites an identifier to look tidier.

import { authenticate } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import { resolveSiteAccess, canRead, type SiteAccess } from "../site-access.js";
import { requireServiceKey } from "../admin/auth.js";
import type { Env } from "../index.js";
import { renderSdsPdf } from "./pdf.js";
import {
  findOrCreateCatalogEntry,
  readCatalogEntry,
  patchCatalogEntry,
  countSitesUsingCatalog,
  searchCatalog,
  setCatalogVerified,
  type SdsCatalogRow
} from "./catalog.js";
import { handleUploadSheet, handleServeSheet, renderBinderPdf } from "./sheets.js";
import { getLocationOptionsFromPricingSimple } from "../db/forms.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_LIMIT = 2000;
const IDENTIFIER_MAX = 300;
const FIELD_MAX = 200;
const NOTES_MAX = 1000;
/** One bulk seed should not be able to fill a site's list with hundreds of
 *  rows nobody reviewed. */
const SEED_MAX = 100;

export interface SdsItemRow {
  id: string;
  location_code: string;
  binder_tab: string | null;
  work_area: string | null;
  sort_order: number;
  notes: string | null;
  is_active: boolean;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  catalog_id: string;
  /** PostgREST embed. What the chemical IS lives here, shared with every other
   *  site holding it -- see ./catalog.ts. */
  catalog: SdsCatalogRow | null;
}

/** Everything a caller needs about one listed chemical, flattened. The split
 *  between site and catalogue is a storage concern; a reader wants one thing. */
const SELECT_WITH_CATALOG = "*,catalog:sds_catalog(*)";

function sbHeaders(env: Env, extra?: Record<string, string>) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(extra ?? {})
  };
}

function isAdminTier(session: { role?: string | null; dcRole?: string | null }): boolean {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

type Gate =
  | { ok: true; access: SiteAccess; email: string }
  | { ok: false; response: Response };

async function gate(env: Env, req: Request): Promise<Gate> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthenticated") };
  }
  const { session } = auth;
  const access = await resolveSiteAccess(env, session.email, isAdminTier(session));
  if (!access.isAdmin && access.locationCodes.length === 0) {
    return { ok: false, response: jsonError(403, "no_accessible_locations") };
  }
  return { ok: true, access, email: session.email };
}

function quoteIn(values: string[]): string {
  return values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** Trim, cap, and collapse an empty string to null so "cleared" and "never set"
 *  are one state in the database rather than two that print differently. */
function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t === "" ? null : t;
}

async function readItem(env: Env, id: string): Promise<SdsItemRow | null> {
  const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  url.searchParams.set("select", SELECT_WITH_CATALOG);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as SdsItemRow[];
  return rows[0] ?? null;
}

/** Locations this request may touch: one when asked for, otherwise all of
 *  them. Returns null when the caller asked for a site they cannot reach. */
function scopeFor(access: SiteAccess, requested: string | null): string[] | null {
  if (requested) {
    if (!canRead(access, requested)) return null;
    return [requested];
  }
  return access.locationCodes;
}

/**
 * Binder order: tab first, then name.
 *
 * Done here rather than in the query because product_identifier lives on the
 * catalogue and PostgREST cannot order a base table by an embedded column.
 * Mirrors compareItems in apps/web -- two bundles, so the logic cannot be
 * imported, but the printed page and the screen must agree on what order the
 * binder is in.
 */
function sortForBinder(items: SdsItemRow[]): SdsItemRow[] {
  return [...items].sort((a, b) => {
    const at = (a.binder_tab ?? "").trim();
    const bt = (b.binder_tab ?? "").trim();
    if (at !== bt) {
      // Untabbed entries last: they are the ones still to be filed.
      if (!at) return 1;
      if (!bt) return -1;
      const an = Number(at);
      const bn = Number(bt);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      if (Number.isFinite(an) !== Number.isFinite(bn)) return Number.isFinite(an) ? -1 : 1;
      const c = at.localeCompare(bt, undefined, { numeric: true });
      if (c !== 0) return c;
    }
    return (a.catalog?.product_identifier ?? "").localeCompare(
      b.catalog?.product_identifier ?? "",
      undefined,
      { sensitivity: "base" }
    );
  });
}

// =============================================================================
// GET /forms/api/sds
// =============================================================================

export async function handleListSds(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const location = url.searchParams.get("location");
  const includeInactive = url.searchParams.get("include_inactive") === "1";

  if (location && !canRead(g.access, location)) return jsonError(403, "forbidden");

  const q = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  q.searchParams.set("select", SELECT_WITH_CATALOG);
  // Ordered by what sds_items ACTUALLY has. product_identifier moved to the
  // catalogue, and PostgREST cannot order a base table by an embedded
  // column -- asking it to 400s the whole request. Name ordering happens in
  // JS below / in the client, where the rows are already in hand.
  q.searchParams.set("order", "location_code.asc,sort_order.asc,created_at.asc");
  q.searchParams.set("limit", String(LIST_LIMIT));
  if (!includeInactive) q.searchParams.set("is_active", "eq.true");

  // An admin has no location list by design, so no filter applies to them.
  if (location) {
    q.searchParams.set("location_code", `eq.${location}`);
  } else if (!g.access.isAdmin) {
    q.searchParams.set("location_code", `in.(${quoteIn(g.access.locationCodes)})`);
  }

  const resp = await fetch(q.toString(), {
    headers: sbHeaders(env, { Prefer: "count=exact" })
  });
  if (!resp.ok) {
    console.error("[forms.sds] list failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "list_failed");
  }
  const items = (await resp.json().catch(() => [])) as SdsItemRow[];

  // Review stamps for whatever sites are in play, so the page can say how
  // current each list is without a second round trip.
  const codes = scopeFor(g.access, location) ?? [];
  let reviews: { location_code: string; last_reviewed_at: string | null; last_reviewed_by: string | null }[] = [];
  const reviewCodes = g.access.isAdmin && !location
    ? [...new Set(items.map((i) => i.location_code))]
    : codes;
  if (reviewCodes.length > 0) {
    const r = new URL("/rest/v1/sds_lists", env.SUPABASE_URL);
    r.searchParams.set("select", "location_code,last_reviewed_at,last_reviewed_by");
    r.searchParams.set("location_code", `in.(${quoteIn(reviewCodes)})`);
    const rr = await fetch(r.toString(), { headers: sbHeaders(env) });
    if (rr.ok) {
      reviews = (await rr.json().catch(() => [])) as typeof reviews;
    }
  }

  // How many sites hold each catalogue entry, so the page can say what an edit
  // ACTUALLY does before somebody does it. Replacing a sheet updating twenty-five
  // binders is the feature; the difference between that and a nasty surprise is
  // entirely whether the number was on screen first.
  //
  // One read of a single column rather than a count per row: at 80 sites this is
  // a couple of thousand ids, and 80 HEAD requests to avoid reading them would be
  // the worse trade.
  const usage: Record<string, number> = {};
  try {
    const u = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
    u.searchParams.set("select", "catalog_id");
    u.searchParams.set("is_active", "eq.true");
    u.searchParams.set("limit", "20000");
    const ur = await fetch(u.toString(), { headers: sbHeaders(env) });
    if (ur.ok) {
      for (const r of (await ur.json().catch(() => [])) as { catalog_id: string }[]) {
        if (r.catalog_id) usage[r.catalog_id] = (usage[r.catalog_id] ?? 0) + 1;
      }
    }
  } catch (err) {
    // A missing count costs a sentence of copy, not correctness. The upload
    // still works and still applies everywhere; the page just cannot say how
    // many, and says so rather than guessing.
    console.error("[forms.sds] usage count failed", err);
  }

  // Site list + display names.
  //
  // AN ADMIN HAS NO locationCodes BY DESIGN -- "everything, no filter
  // applies" -- and on a table this new there are no items to infer sites from
  // either. Returning the access list verbatim therefore gave an admin an empty
  // site picker and no way to add anything: a dead end on a brand-new tool,
  // which is exactly when it is least obvious whether the tool or the data is
  // at fault. So an admin gets every site, and everyone else gets theirs.
  //
  // Names come along because a picker of location_codes is a wall of slugs, and
  // it is the same query either way.
  const all = await getLocationOptionsFromPricingSimple(env);
  const siteNames: Record<string, string> = {};
  for (const o of all) {
    if (o.code && o.pretty) siteNames[o.code] = o.pretty;
  }
  const locations = g.access.isAdmin
    ? all.map((o) => o.code).filter(Boolean)
    : g.access.locationCodes;

  return json({
    items,
    reviews,
    locations,
    site_names: siteNames,
    catalog_usage: usage,
    scope: g.access.isAdmin ? "all" : "scoped",
    limit_hit: items.length >= LIST_LIMIT
  });
}

// =============================================================================
// POST /forms/api/sds
// =============================================================================

export async function handleCreateSds(env: Env, req: Request): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, "bad_request");

  const location = typeof body.location_code === "string" ? body.location_code : "";
  if (!location || !canRead(g.access, location)) return jsonError(403, "forbidden");

  // Two ways in. Picking an existing catalogue entry is the one that matters:
  // fifty sites holding unleaded gasoline should be fifty rows pointing at ONE
  // chemical, inheriting its sheet, not fifty near-duplicates nobody can tell
  // apart on a printed index.
  let entryFromId: Awaited<ReturnType<typeof findOrCreateCatalogEntry>> = null;
  if (typeof body.catalog_id === "string" && UUID_RE.test(body.catalog_id)) {
    entryFromId = await readCatalogEntry(env, body.catalog_id);
    if (!entryFromId) return jsonError(404, "catalog_entry_not_found");
  }

  const identifier = entryFromId
    ? entryFromId.product_identifier
    : optionalText(body.product_identifier, IDENTIFIER_MAX);
  if (!identifier) return jsonError(400, "product_identifier_required");

  // The chemical first, the placement second. Two sites adding the same product
  // land on the SAME catalogue row, which is the whole point: one sheet, one
  // manufacturer, one revision date, however many binders.
  const entry =
    entryFromId ??
    (await findOrCreateCatalogEntry(env, {
      product_identifier: identifier,
      manufacturer: optionalText(body.manufacturer, FIELD_MAX) ?? null,
      email: g.email
    }));
  if (!entry) return jsonError(502, "catalog_failed");

  const row = {
    location_code: location,
    catalog_id: entry.id,
    work_area: optionalText(body.work_area, FIELD_MAX) ?? null,
    binder_tab: optionalText(body.binder_tab, 20) ?? null,
    notes: optionalText(body.notes, NOTES_MAX) ?? null,
    sort_order: Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0,
    created_by: g.email,
    updated_by: g.email
  };

  const resp = await fetch(new URL("/rest/v1/sds_items", env.SUPABASE_URL).toString(), {
    method: "POST",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify(row)
  });
  if (resp.status === 409) return jsonError(409, "duplicate_active_item");
  if (!resp.ok) {
    console.error("[forms.sds] create failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "create_failed");
  }
  const created = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json({ item: { ...(created[0] ?? {}), catalog: entry } }, 201);
}

// =============================================================================
// PATCH /forms/api/sds/{id}
// =============================================================================

export async function handlePatchSds(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const existing = await readItem(env, id);
  if (!existing || !canRead(g.access, existing.location_code)) {
    // Not-found and not-yours are the same answer, so an id cannot be probed.
    return jsonError(404, "not_found");
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, "bad_request");

  // TWO DESTINATIONS, and which is which is the whole model. Where the chemical
  // sits is this site's business; what the chemical IS belongs to every site
  // holding it, so those edits go to the shared row and change all of them.
  const sitePatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: g.email
  };
  const catalogPatch: Record<string, unknown> = {};

  for (const [key, max] of [
    ["work_area", FIELD_MAX],
    ["notes", NOTES_MAX],
    ["binder_tab", 20]
  ] as const) {
    const v = optionalText(body[key], max);
    if (v !== undefined) sitePatch[key] = v;
  }
  if (typeof body.sort_order === "number" && Number.isFinite(body.sort_order)) {
    sitePatch.sort_order = Math.trunc(body.sort_order);
  }
  // Removal is soft and STAMPED here rather than by the caller, so a row can
  // never claim it left on a date nobody recorded.
  if (typeof body.is_active === "boolean" && body.is_active !== existing.is_active) {
    sitePatch.is_active = body.is_active;
    sitePatch.removed_at = body.is_active ? null : new Date().toISOString();
    sitePatch.removed_by = body.is_active ? null : g.email;
  }

  if (body.product_identifier !== undefined) {
    const v = optionalText(body.product_identifier, IDENTIFIER_MAX);
    if (!v) return jsonError(400, "product_identifier_required");
    catalogPatch.product_identifier = v;
  }
  for (const [key, max] of [
    ["manufacturer", FIELD_MAX],
    ["source_url", 500]
  ] as const) {
    const v = optionalText(body[key], max);
    if (v !== undefined) catalogPatch[key] = v;
  }
  // A date, or an explicit clear. Anything unparseable is IGNORED rather than
  // stored: a wrong revision date is worse than none on a field whose whole job
  // is saying how current the sheet is.
  if (body.sds_revision_date === null) {
    catalogPatch.sds_revision_date = null;
  } else if (typeof body.sds_revision_date === "string") {
    const d = body.sds_revision_date.trim();
    if (d === "") catalogPatch.sds_revision_date = null;
    else if (ISO_DATE_RE.test(d)) catalogPatch.sds_revision_date = d;
  }

  if (Object.keys(catalogPatch).length > 0) {
    catalogPatch.updated_by = g.email;
    const updated = await patchCatalogEntry(env, existing.catalog_id, catalogPatch);
    if (!updated) return jsonError(502, "patch_failed");
  }

  if (Object.keys(sitePatch).length === 2 && Object.keys(catalogPatch).length === 0) {
    return json({ item: existing, unchanged: true });
  }

  const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("select", SELECT_WITH_CATALOG);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify(sitePatch)
  });
  if (resp.status === 409) return jsonError(409, "duplicate_active_item");
  if (!resp.ok) {
    console.error("[forms.sds] patch failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "patch_failed");
  }
  const rows = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json({ item: rows[0] ?? (await readItem(env, id)) });
}

// =============================================================================
// GET /forms/api/sds/candidates
// =============================================================================

export async function handleSdsCandidates(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const location = new URL(req.url).searchParams.get("location");
  if (!location) return jsonError(400, "location_required");
  if (!canRead(g.access, location)) return jsonError(403, "forbidden");

  const q = new URL("/rest/v1/sds_inventory_candidates", env.SUPABASE_URL);
  q.searchParams.set("select", "product_id,product_name,description");
  q.searchParams.set("location_code", `eq.${location}`);
  q.searchParams.set("order", "product_name.asc");
  const resp = await fetch(q.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    console.error("[forms.sds] candidates failed", resp.status);
    return jsonError(502, "candidates_failed");
  }
  const all = (await resp.json().catch(() => [])) as {
    product_id: string;
    product_name: string;
    description: string | null;
  }[];

  // Hide what is already on the list, by provenance OR by name. Provenance
  // alone would re-offer a chemical somebody had already typed by hand.
  const existing = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  existing.searchParams.set("select", "catalog:sds_catalog(source_product_id,product_identifier)");
  existing.searchParams.set("location_code", `eq.${location}`);
  existing.searchParams.set("is_active", "eq.true");
  const er = await fetch(existing.toString(), { headers: sbHeaders(env) });
  const taken = er.ok
    ? ((await er.json().catch(() => [])) as {
        catalog: { source_product_id: string | null; product_identifier: string } | null;
      }[])
    : [];
  const takenIds = new Set(taken.map((t) => t.catalog?.source_product_id).filter(Boolean));
  const takenNames = new Set(
    taken
      .map((t) => t.catalog?.product_identifier?.trim().toLowerCase())
      .filter((n): n is string => Boolean(n))
  );

  return json({
    candidates: all.filter(
      (c) => !takenIds.has(c.product_id) && !takenNames.has(c.product_name.trim().toLowerCase())
    )
  });
}

// =============================================================================
// POST /forms/api/sds/seed
// =============================================================================

export async function handleSeedSds(env: Env, req: Request): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, "bad_request");
  const location = typeof body.location_code === "string" ? body.location_code : "";
  if (!location || !canRead(g.access, location)) return jsonError(403, "forbidden");

  const ids = Array.isArray(body.product_ids)
    ? [...new Set(body.product_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))]
    : [];
  if (ids.length === 0) return jsonError(400, "no_products");
  if (ids.length > SEED_MAX) return jsonError(400, "too_many_products");

  // Re-read the names server-side rather than trusting the ones posted: the
  // identifier is the load-bearing field on this list, and a client-supplied
  // name could say anything.
  const q = new URL("/rest/v1/sds_inventory_candidates", env.SUPABASE_URL);
  q.searchParams.set("select", "product_id,product_name");
  q.searchParams.set("location_code", `eq.${location}`);
  q.searchParams.set("product_id", `in.(${ids.join(",")})`);
  const cr = await fetch(q.toString(), { headers: sbHeaders(env) });
  if (!cr.ok) return jsonError(502, "candidates_failed");
  const found = (await cr.json().catch(() => [])) as {
    product_id: string;
    product_name: string;
  }[];
  if (found.length === 0) return jsonError(400, "no_products");

  // One catalogue lookup per product. A product already listed at another site
  // resolves to the EXISTING row, so this site inherits its sheet, manufacturer
  // and revision date immediately -- nothing to re-upload, nothing to retype.
  const rows: Record<string, unknown>[] = [];
  let inherited = 0;
  for (const [i, f] of found.entries()) {
    const entry = await findOrCreateCatalogEntry(env, {
      product_identifier: f.product_name.slice(0, IDENTIFIER_MAX),
      source_product_id: f.product_id,
      email: g.email
    });
    if (!entry) continue;
    if (entry.sds_r2_key) inherited++;
    rows.push({
      location_code: location,
      catalog_id: entry.id,
      sort_order: i,
      created_by: g.email,
      updated_by: g.email
    });
  }
  if (rows.length === 0) return jsonError(502, "catalog_failed");

  const resp = await fetch(new URL("/rest/v1/sds_items", env.SUPABASE_URL).toString(), {
    method: "POST",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=ignore-duplicates"
    }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    console.error("[forms.sds] seed failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "seed_failed");
  }
  const created = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json(
    { items: created, requested: ids.length, created: created.length, inherited_sheets: inherited },
    201
  );
}

// =============================================================================
// POST /forms/api/sds/review
// =============================================================================

export async function handleReviewSds(env: Env, req: Request): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const location = body && typeof body.location_code === "string" ? body.location_code : "";
  if (!location || !canRead(g.access, location)) return jsonError(403, "forbidden");

  const url = new URL("/rest/v1/sds_lists", env.SUPABASE_URL);
  url.searchParams.set("on_conflict", "location_code");
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    }),
    body: JSON.stringify({
      location_code: location,
      last_reviewed_at: new Date().toISOString(),
      last_reviewed_by: g.email
    })
  });
  if (!resp.ok) {
    console.error("[forms.sds] review failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "review_failed");
  }
  const rows = (await resp.json().catch(() => [])) as {
    location_code: string;
    last_reviewed_at: string;
    last_reviewed_by: string;
  }[];
  return json({ review: rows[0] ?? null });
}

// =============================================================================
// GET /forms/api/sds/print.pdf
// =============================================================================

/**
 * The printable table of contents.
 *
 * Rendered server-side with the same `drawTable` the completed-form PDFs use,
 * so a binder cover page looks like every other document this system produces
 * rather than like a browser print of a web table.
 *
 * ACTIVE ITEMS ONLY. A removed chemical stays in the database with the date it
 * left -- that is the audit trail -- but printing it would assert it is on site,
 * which is the one thing this page must not get wrong.
 */
export async function handlePrintSds(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const location = new URL(req.url).searchParams.get("location");
  if (!location) return jsonError(400, "location_required");
  if (!canRead(g.access, location)) return jsonError(403, "forbidden");

  const q = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  q.searchParams.set("select", SELECT_WITH_CATALOG);
  q.searchParams.set("location_code", `eq.${location}`);
  q.searchParams.set("is_active", "eq.true");
  // Ordered by what sds_items ACTUALLY has. product_identifier moved to the
  // catalogue, and PostgREST cannot order a base table by an embedded
  // column -- asking it to 400s the whole request. Name ordering happens in
  // JS below / in the client, where the rows are already in hand.
  q.searchParams.set("order", "sort_order.asc,created_at.asc");
  const resp = await fetch(q.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return jsonError(502, "list_failed");
  const items = (await resp.json().catch(() => [])) as SdsItemRow[];

  const r = new URL("/rest/v1/sds_lists", env.SUPABASE_URL);
  r.searchParams.set("select", "last_reviewed_at,last_reviewed_by");
  r.searchParams.set("location_code", `eq.${location}`);
  const rr = await fetch(r.toString(), { headers: sbHeaders(env) });
  const reviews = rr.ok
    ? ((await rr.json().catch(() => [])) as {
        last_reviewed_at: string | null;
        last_reviewed_by: string | null;
      }[])
    : [];

  // Prettiest available name for the site, for the page header. Falls back to
  // the code rather than leaving the header blank.
  let siteName = location;
  try {
    const p = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
    p.searchParams.set("select", "location_pretty");
    p.searchParams.set("location_code", `eq.${location}`);
    p.searchParams.set("limit", "1");
    const pr = await fetch(p.toString(), { headers: sbHeaders(env) });
    if (pr.ok) {
      const rows = (await pr.json().catch(() => [])) as { location_pretty: string | null }[];
      if (rows[0]?.location_pretty) siteName = rows[0].location_pretty;
    }
  } catch {
    // Header falls back to the location_code.
  }

  const bytes = await renderSdsPdf({
    siteName,
    locationCode: location,
    items: sortForBinder(items),
    lastReviewedAt: reviews[0]?.last_reviewed_at ?? null,
    lastReviewedBy: reviews[0]?.last_reviewed_by ?? null,
    bucket: env.FORMS_FILES
  });

  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // inline, not attachment: this is printed far more often than it is
      // filed, and a download step between "open" and "print" is friction on
      // the one action the page exists for.
      "Content-Disposition": `inline; filename="sds-index-${location}.pdf"`,
      "Cache-Control": "no-store"
    }
  });
}

/** Patch helper shared with ./sheets.ts, so an upload stamps the row through
 *  the same path an edit does rather than a second PostgREST call with its own
 *  error handling. */
export async function patchSdsRow(
  env: Env,
  id: string,
  body: Record<string, unknown>
): Promise<Response> {
  const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    console.error("[forms.sds] patch failed", resp.status);
    return jsonError(502, "patch_failed");
  }
  const rows = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json({ item: rows[0] ?? null });
}

export { readItem as readSdsItem, gate as sdsGate, canRead as sdsCanRead };

// =============================================================================
// Sheets: upload one, serve one, print the binder
// =============================================================================

/** Shared plumbing so every sheet route asks the SAME question about access
 *  that the rest of this file does. A second answer would drift. */
async function sheetCtx(env: Env, req: Request) {
  const g = await gate(env, req);
  if (!g.ok) return { ok: false as const, response: g.response };
  return {
    ok: true as const,
    email: g.email,
    access: g.access,
    ctx: {
      readItem: (id: string) => readItem(env, id),
      canRead: (loc: string) => canRead(g.access, loc),
      email: g.email,
      // Patches the CATALOGUE. A sheet belongs to the chemical, so uploading
      // one updates every site holding it -- which is the feature, and why the
      // UI states the site count before the file picker opens.
      patch: async (catalogId: string, body: Record<string, unknown>) => {
        const updated = await patchCatalogEntry(env, catalogId, body);
        if (!updated) return jsonError(502, "patch_failed");
        return json({ catalog: updated });
      }
    }
  };
}

export async function handleSdsSheetUpload(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const c = await sheetCtx(env, req);
  if (!c.ok) return c.response;
  return handleUploadSheet(env, req, id, c.ctx);
}

export async function handleSdsSheetServe(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const c = await sheetCtx(env, req);
  if (!c.ok) return c.response;
  return handleServeSheet(env, id, c.ctx);
}

/**
 * GET /forms/api/sds/binder.pdf?location= -- index page plus every sheet, in
 * tab order, as one print job.
 *
 * Sheets that are missing or unmergeable are reported in headers rather than
 * failing the request: fifteen good sheets are still worth printing, and a
 * binder that refuses to print because one file is bad is the worst possible
 * handling of one bad file.
 */
export async function handleSdsBinder(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const location = new URL(req.url).searchParams.get("location");
  if (!location) return jsonError(400, "location_required");
  if (!canRead(g.access, location)) return jsonError(403, "forbidden");

  const q = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  q.searchParams.set("select", SELECT_WITH_CATALOG);
  q.searchParams.set("location_code", `eq.${location}`);
  q.searchParams.set("is_active", "eq.true");
  // Ordered by what sds_items ACTUALLY has. product_identifier moved to the
  // catalogue, and PostgREST cannot order a base table by an embedded
  // column -- asking it to 400s the whole request. Name ordering happens in
  // JS below / in the client, where the rows are already in hand.
  q.searchParams.set("order", "sort_order.asc,created_at.asc");
  const resp = await fetch(q.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return jsonError(502, "list_failed");
  const items = (await resp.json().catch(() => [])) as SdsItemRow[];

  const r = new URL("/rest/v1/sds_lists", env.SUPABASE_URL);
  r.searchParams.set("select", "last_reviewed_at,last_reviewed_by");
  r.searchParams.set("location_code", `eq.${location}`);
  const rr = await fetch(r.toString(), { headers: sbHeaders(env) });
  const reviews = rr.ok
    ? ((await rr.json().catch(() => [])) as { last_reviewed_at: string | null; last_reviewed_by: string | null }[])
    : [];

  let siteName = location;
  try {
    const p = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
    p.searchParams.set("select", "location_pretty");
    p.searchParams.set("location_code", `eq.${location}`);
    p.searchParams.set("limit", "1");
    const pr = await fetch(p.toString(), { headers: sbHeaders(env) });
    if (pr.ok) {
      const rows = (await pr.json().catch(() => [])) as { location_pretty: string | null }[];
      if (rows[0]?.location_pretty) siteName = rows[0].location_pretty;
    }
  } catch {
    // Header falls back to the location_code.
  }

  const built = await renderBinderPdf(env, {
    siteName,
    locationCode: location,
    items: sortForBinder(items),
    lastReviewedAt: reviews[0]?.last_reviewed_at ?? null,
    lastReviewedBy: reviews[0]?.last_reviewed_by ?? null
  });

  return new Response(built.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="sds-binder-${location}.pdf"`,
      "Cache-Control": "no-store",
      "X-Sds-Missing": String(built.missing.length),
      "X-Sds-Failed": String(built.failed.length)
    }
  });
}

// =============================================================================
// GET /forms/api/sds/catalog  -- search the shared chemical list
// =============================================================================

export async function handleSearchCatalog(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  // Any caller who can reach the SDS surface at all may search it. The
  // catalogue is a list of chemical names and public safety data sheets, not
  // anything site-scoped -- gating it per location would only stop a site
  // finding the entry it is supposed to reuse.
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const rows = await searchCatalog(env, {
    q: url.searchParams.get("q") ?? undefined,
    verifiedOnly: url.searchParams.get("verified_only") === "1"
  });
  return json({ catalog: rows, can_verify: g.access.isAdmin });
}

// =============================================================================
// POST /forms/api/sds/catalog/{id}/verify
// =============================================================================

export async function handleVerifyCatalog(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  // Deliberately NOT something a site can set for itself: the entire value of
  // the badge is that somebody accountable for checking did the checking.
  if (!g.access.isAdmin) return jsonError(403, "verification_is_admin_only");

  const body = (await req.json().catch(() => null)) as { verified?: unknown } | null;
  const verified = body?.verified !== false;
  const updated = await setCatalogVerified(env, id, verified, g.email);
  if (!updated) return jsonError(502, "verify_failed");
  return json({ catalog: updated });
}
