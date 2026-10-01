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
  deleteCatalogEntry,
  searchCatalog,
  setCatalogVerified,
  type SdsCatalogRow
} from "./catalog.js";
import {
  handleUploadSheet,
  handleServeSheet,
  handleCatalogUpload,
  isPdf,
  handleServeCatalogSheet,
  renderBinderPdf
} from "./sheets.js";
import { linkAlias, loadAliasMap, unlinkAlias } from "./aliases.js";
import { assignTabs, nextTabFor, TAB_LIMIT } from "./tabs.js";
import {
  listSafetyDocs,
  readSafetyDoc,
  serveSafetyDoc,
  safetyDocKey
} from "./safety-docs.js";
import { mergeCatalogEntries } from "./merge.js";
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
/** A written programme is text, not scans of a binder. Generous, but not so
 *  generous that a 40 MB export lands in every site's inbox path. */
const SAFETY_DOC_MAX_BYTES = 15 * 1024 * 1024;

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
 * Index order: BY TAB NUMBER, then by name.
 *
 * OPERATOR DECISION, 2026-09-28, reversing an earlier call of mine. I had this
 * sorting alphabetically with the tab as a column, on the reasoning that the
 * index is a lookup and the number is just an address -- which is how a parts
 * catalogue works. It is not how a binder of numbered dividers reads. A Tab
 * column running 32, 37, 33, 34 is wrong on its face to anyone holding the
 * page, and "can't have numerical tabs out of sequence" settles it: the printed
 * column has to count.
 *
 * THE COST, so nobody re-litigates this by accident: a chemical added after the
 * binder was numbered takes the next free number and therefore prints LAST,
 * away from its alphabetical neighbours, until somebody presses Renumber A-Z.
 * That is the deliberate trade -- an index that reads in order, at the price of
 * re-filing sheets when you want it alphabetical again.
 *
 * Untabbed rows sort last: they are the ones still to be filed. Numeric tabs
 * sort NUMERICALLY, so 10 follows 9 rather than 1.
 *
 * Done here rather than in the query because product_identifier lives on the
 * catalogue and PostgREST cannot order a base table by an embedded column.
 * Mirrors compareItems in apps/web -- two bundles, so the logic cannot be
 * imported, but the printed page and the screen must agree.
 */
function sortForBinder(items: SdsItemRow[]): SdsItemRow[] {
  return [...items].sort((a, b) => {
    const at = (a.binder_tab ?? "").trim();
    const bt = (b.binder_tab ?? "").trim();
    if (at !== bt) {
      if (!at) return 1;
      if (!bt) return -1;
      const an = Number(at);
      const bn = Number(bt);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      // A lettered tab sorts after every numbered one rather than being coerced
      // to NaN and shuffling unpredictably.
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

  // An explicit tab wins. Otherwise append -- but only at a site that has
  // already been numbered, so a site still building its list stays untabbed
  // until somebody presses the button.
  const explicitTab = optionalText(body.binder_tab, 20) ?? null;

  const row = {
    location_code: location,
    catalog_id: entry.id,
    work_area: optionalText(body.work_area, FIELD_MAX) ?? null,
    binder_tab: explicitTab ?? (await nextTabFor(env, location)),
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
    // A VERIFIED ENTRY IS READ-ONLY TO EVERYONE BUT AN ADMIN.
    //
    // Without this, any site contact could rename a verified chemical or change
    // its revision date, which silently clears the badge -- so the assurance
    // would be undone by somebody who was never allowed to grant it. The
    // placement (tab, work area, presence) stays theirs; what the chemical IS
    // does not, once somebody accountable has vouched for it.
    const current = await readCatalogEntry(env, existing.catalog_id);
    if (current?.verified_at && !g.access.isAdmin) {
      return jsonError(403, "verified_entry_is_admin_only");
    }
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

  // Hide what is already on the list, by alias OR by name. The alias covers the
  // case the name cannot: this site stocks "DS-FWW-CS" and the list already
  // carries it as "Flash Wax White", which share no characters.
  const existing = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  existing.searchParams.set("select", "catalog_id,catalog:sds_catalog(product_identifier)");
  existing.searchParams.set("location_code", `eq.${location}`);
  existing.searchParams.set("is_active", "eq.true");
  const er = await fetch(existing.toString(), { headers: sbHeaders(env) });
  const taken = er.ok
    ? ((await er.json().catch(() => [])) as {
        catalog_id: string;
        catalog: { product_identifier: string } | null;
      }[])
    : [];
  const takenCatalogIds = new Set(taken.map((t) => t.catalog_id));
  const takenNames = new Set(
    taken
      .map((t) => t.catalog?.product_identifier?.trim().toLowerCase())
      .filter((n): n is string => Boolean(n))
  );

  // A failed alias read must not quietly re-offer chemicals the site already
  // has; better to surface the fault than to invite a duplicate.
  let aliases: Map<string, string>;
  try {
    aliases = await loadAliasMap(env);
  } catch (err) {
    console.error("[forms.sds] candidates alias map failed", err);
    return jsonError(502, "candidates_failed");
  }

  // What each surviving candidate will actually be CALLED once added. A site
  // ticking "L-UF222-CS" gets a row reading "UF222 - Ultra Presoak", and without
  // saying so up front the obvious reaction is "that is not what I picked" --
  // followed by adding the right-looking name by hand, which is the duplicate
  // this whole mechanism exists to stop.
  const survivors = all.filter((c) => {
    const aliasedTo = aliases.get(c.product_id);
    if (aliasedTo && takenCatalogIds.has(aliasedTo)) return false;
    return !takenNames.has(c.product_name.trim().toLowerCase());
  });

  const resolvedIds = [
    ...new Set(
      survivors.map((c) => aliases.get(c.product_id)).filter((v): v is string => Boolean(v))
    )
  ];
  const nameById = new Map<string, string>();
  if (resolvedIds.length > 0) {
    try {
      const n = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
      n.searchParams.set("select", "id,product_identifier");
      n.searchParams.set("id", `in.(${resolvedIds.join(",")})`);
      n.searchParams.set("limit", String(resolvedIds.length));
      const nr = await fetch(n.toString(), { headers: sbHeaders(env) });
      if (nr.ok) {
        for (const r of (await nr.json().catch(() => [])) as {
          id: string;
          product_identifier: string;
        }[]) {
          nameById.set(r.id, r.product_identifier);
        }
      }
    } catch (err) {
      // A missing label costs a hint, not the ability to add the chemical.
      console.error("[forms.sds] candidate resolved-name lookup failed", err);
    }
  }

  return json({
    candidates: survivors.map((c) => {
      const aliasedTo = aliases.get(c.product_id);
      const resolved = aliasedTo ? (nameById.get(aliasedTo) ?? null) : null;
      return {
        ...c,
        // Null when it resolves to nothing, or to a name already identical --
        // the picker only needs to warn where the label will CHANGE.
        catalog_name:
          resolved && resolved.trim().toLowerCase() !== c.product_name.trim().toLowerCase()
            ? resolved
            : null
      };
    })
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

  // Number the new rows only if this site is already numbered. Done AFTER the
  // insert rather than in the payload because `ignore-duplicates` silently drops
  // rows, and numbers computed up front would leave gaps for adds that never
  // happened. `fill` never touches a tab that already exists, so it cannot move
  // anything already filed in the binder.
  if (created.length > 0 && (await nextTabFor(env, location)) !== null) {
    try {
      await assignTabs(env, location, "fill", g.email);
    } catch (err) {
      // An unnumbered row is visible and fixable from the page; losing the seed
      // would not be.
      console.warn("[forms.sds] seed tab fill failed", err);
    }
  }

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
      isAdmin: g.access.isAdmin,
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
    lastReviewedBy: reviews[0]?.last_reviewed_by ?? null,
    // Opt-in: the padding blanks are invisible when duplexed and pure waste
    // when not, so only the operator knows which is right.
    duplex: new URL(req.url).searchParams.get("duplex") === "1"
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

// =============================================================================
// Catalogue administration
//
// The catalogue is ORG-WIDE, so building it out of the per-site add flow means
// hopping between sites to enter chemicals that have nothing to do with which
// site you happen to be looking at. These endpoints let an admin curate it
// directly: create an entry before any site holds it, fix one, attach its sheet.
// =============================================================================

/** Every catalogue write here is admin-tier. Curating the shared record is not
 *  a site's job, and a verified entry is admin-only by the same rule. */
async function adminGate(env: Env, req: Request) {
  const g = await gate(env, req);
  if (!g.ok) return { ok: false as const, response: g.response };
  if (!g.access.isAdmin) {
    return { ok: false as const, response: jsonError(403, "admin_only") };
  }
  return { ok: true as const, email: g.email };
}

/** POST /forms/api/sds/catalog — add a chemical to the shared list, with no
 *  site attached. This is how the catalogue gets built ahead of the sites. */
export async function handleCreateCatalog(env: Env, req: Request): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, "bad_request");
  const identifier = optionalText(body.product_identifier, IDENTIFIER_MAX);
  if (!identifier) return jsonError(400, "product_identifier_required");

  // Find-or-create rather than plain insert: an admin adding a chemical some
  // site already entered by hand should land on THAT row and improve it, not
  // create a second one for the same thing.
  const entry = await findOrCreateCatalogEntry(env, {
    product_identifier: identifier,
    manufacturer: optionalText(body.manufacturer, FIELD_MAX) ?? null,
    email: g.email
  });
  if (!entry) return jsonError(502, "catalog_failed");
  return json({ catalog: entry }, 201);
}

/** PATCH /forms/api/sds/catalog/{id} — edit the shared record. */
export async function handlePatchCatalog(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, "bad_request");

  const patch: Record<string, unknown> = { updated_by: g.email };
  if (body.product_identifier !== undefined) {
    const v = optionalText(body.product_identifier, IDENTIFIER_MAX);
    if (!v) return jsonError(400, "product_identifier_required");
    patch.product_identifier = v;
  }
  for (const [key, max] of [
    ["manufacturer", FIELD_MAX],
    ["source_url", 500]
  ] as const) {
    const v = optionalText(body[key], max);
    if (v !== undefined) patch[key] = v;
  }
  if (body.sds_revision_date === null) {
    patch.sds_revision_date = null;
  } else if (typeof body.sds_revision_date === "string") {
    const d = body.sds_revision_date.trim();
    if (d === "") patch.sds_revision_date = null;
    else if (ISO_DATE_RE.test(d)) patch.sds_revision_date = d;
  }

  // Still clears verification, even for an admin. The badge is a claim about a
  // specific name and a specific sheet; editing either means nobody has checked
  // the new pairing yet. Re-verifying is one click, and that click is somebody
  // saying they looked.
  const updated = await patchCatalogEntry(env, id, patch);
  if (!updated) return jsonError(502, "patch_failed");
  return json({ catalog: updated });
}

/** POST /forms/api/sds/catalog/{id}/sheet — attach a sheet with no site row in
 *  play, so the catalogue can be stocked before anywhere holds the chemical. */
export async function handleCatalogSheetUpload(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_id");
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;

  const entry = await readCatalogEntry(env, id);
  if (!entry) return jsonError(404, "catalog_entry_not_found");
  return handleCatalogUpload(env, req, entry, g.email);
}

// =============================================================================
// GET /forms/api/sds/inventory-products  -- the master product list
// =============================================================================

/**
 * Every product inventory knows about, so the catalogue can be stocked from the
 * names ACTUALLY IN USE instead of typed from memory.
 *
 * Typing was the problem: an admin writing "Presoak HWS 2X" when inventory
 * holds "Presoak HWS *2X*" creates a second entry for one chemical, and the
 * site that later searches for its own product finds neither convincing. This
 * hands over the real identifier.
 *
 * Defaults to products in use somewhere -- 106 of the 469, the rest being
 * historical -- ordered by how many sites stock them. That ordering is the
 * point: a product at 40 sites earns a sheet before one at none, and it turns
 * "stock the catalogue" from an unbounded chore into a ranked list.
 */
export async function handleInventoryProducts(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const includeUnused = url.searchParams.get("include_unused") === "1";

  const p = new URL("/rest/v1/sds_inventory_products", env.SUPABASE_URL);
  p.searchParams.set("select", "product_id,product_name,description,site_count");
  p.searchParams.set("order", "site_count.desc,product_name.asc");
  p.searchParams.set("limit", "500");
  if (!includeUnused) p.searchParams.set("site_count", "gt.0");
  if (q) {
    p.searchParams.set("product_name", `ilike.*${q.replace(/[\%_]/g, (c) => `\${c}`)}*`);
  }
  const pr = await fetch(p.toString(), { headers: sbHeaders(env) });
  if (!pr.ok) {
    console.error("[forms.sds] inventory products failed", pr.status);
    return jsonError(502, "inventory_products_failed");
  }
  const products = (await pr.json().catch(() => [])) as {
    product_id: string;
    product_name: string;
    description: string | null;
    site_count: number;
  }[];

  // Which already resolve to a catalogue entry, by ALIAS or by name. The alias
  // is what connects a purchasing code to a chemical -- "DS-FWW-CS" and "Flash
  // Wax White" share no characters, so only a recorded link joins them.
  const c = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  c.searchParams.set("select", "id,product_identifier,sds_r2_key,verified_at");
  c.searchParams.set("limit", "5000");
  const cr = await fetch(c.toString(), { headers: sbHeaders(env) });
  if (!cr.ok) return jsonError(502, "catalog_read_failed");
  const entries = (await cr.json().catch(() => [])) as {
    id: string;
    product_identifier: string;
    sds_r2_key: string | null;
    verified_at: string | null;
  }[];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byName = new Map(
    entries.map((e) => [e.product_identifier.trim().toLowerCase(), e])
  );

  let aliases: Map<string, string>;
  try {
    aliases = await loadAliasMap(env);
  } catch (err) {
    // Refuse rather than degrade. An empty alias map would present every already
    // linked purchasing code as a brand-new chemical, which is the one outcome
    // this screen exists to prevent.
    console.error("[forms.sds] inventory products alias map failed", err);
    return jsonError(502, "alias_map_failed");
  }

  return json({
    products: products.map((prod) => {
      const aliasedTo = aliases.get(prod.product_id);
      const hit =
        (aliasedTo ? byId.get(aliasedTo) : undefined) ??
        byName.get(prod.product_name.trim().toLowerCase());
      return {
        ...prod,
        catalog_id: hit?.id ?? null,
        catalog_name: hit?.product_identifier ?? null,
        has_sheet: Boolean(hit?.sds_r2_key),
        verified: Boolean(hit?.verified_at),
        // How it resolved, so the screen can say "linked to Flash Wax White"
        // rather than a bare "already there" that hides whether a person said so.
        matched_by: aliasedTo && byId.has(aliasedTo) ? "alias" : hit ? "name" : null
      };
    })
  });
}

// =============================================================================
// POST /forms/api/sds/catalog/from-inventory
// =============================================================================

/** Create catalogue entries for the picked inventory products, using their real
 *  names. find-or-create per product, so re-picking something already present
 *  is a no-op rather than a duplicate. */
export async function handleCatalogFromInventory(
  env: Env,
  req: Request
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const ids = Array.isArray(body?.product_ids)
    ? [...new Set(body.product_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))]
    : [];
  if (ids.length === 0) return jsonError(400, "no_products");
  if (ids.length > SEED_MAX) return jsonError(400, "too_many_products");

  // Names read server-side. The identifier is the load-bearing field on this
  // list and a client-supplied one could say anything.
  const p = new URL("/rest/v1/sds_inventory_products", env.SUPABASE_URL);
  p.searchParams.set("select", "product_id,product_name");
  p.searchParams.set("product_id", `in.(${ids.join(",")})`);
  const pr = await fetch(p.toString(), { headers: sbHeaders(env) });
  if (!pr.ok) return jsonError(502, "inventory_products_failed");
  const found = (await pr.json().catch(() => [])) as {
    product_id: string;
    product_name: string;
  }[];
  if (found.length === 0) return jsonError(400, "no_products");

  // Skip what the LISTING already called resolved, using the same rule it used.
  // If create decided "already there" differently, the screen would disable a row
  // this endpoint would cheerfully duplicate, and the two would drift silently.
  const c = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  c.searchParams.set("select", "product_identifier");
  c.searchParams.set("limit", "5000");
  const cr = await fetch(c.toString(), { headers: sbHeaders(env) });
  if (!cr.ok) return jsonError(502, "catalog_read_failed");
  const entries = (await cr.json().catch(() => [])) as {
    product_identifier: string;
  }[];
  const knownNames = new Set(
    entries.map((e) => e.product_identifier.trim().toLowerCase())
  );
  let aliases: Map<string, string>;
  try {
    aliases = await loadAliasMap(env);
  } catch (err) {
    console.error("[forms.sds] from-inventory alias map failed", err);
    return jsonError(502, "alias_map_failed");
  }

  let created = 0;
  let skipped = 0;
  for (const f of found) {
    if (aliases.has(f.product_id) || knownNames.has(f.product_name.trim().toLowerCase())) {
      skipped++;
      continue;
    }
    const entry = await findOrCreateCatalogEntry(env, {
      product_identifier: f.product_name.slice(0, IDENTIFIER_MAX),
      source_product_id: f.product_id,
      email: g.email
    });
    if (entry) created++;
  }
  return json({ requested: ids.length, created, skipped }, 201);
}

// =============================================================================
// POST   /forms/api/sds/catalog/{id}/aliases   {source_product_id}
// DELETE /forms/api/sds/catalog/{id}/aliases/{productId}
// =============================================================================

/**
 * Record that an inventory product IS this chemical.
 *
 * Admin-tier, the same gate as verification and for the same reason: saying two
 * things are one chemical decides which safety data sheet somebody is handed.
 * Getting it wrong is not a tidiness problem.
 *
 * Linking does NOT clear the entry's verified badge. The badge is a claim about
 * this entry's own name and sheet, and neither changed -- a new purchasing code
 * pointing at it does not un-check what somebody checked.
 */
export async function handleLinkAlias(
  env: Env,
  req: Request,
  catalogId: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;
  if (!UUID_RE.test(catalogId)) return jsonError(400, "bad_catalog_id");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const productId = typeof body?.source_product_id === "string" ? body.source_product_id : "";
  if (!UUID_RE.test(productId)) return jsonError(400, "bad_source_product_id");

  const entry = await readCatalogEntry(env, catalogId);
  if (!entry) return jsonError(404, "catalog_entry_not_found");

  // Name read server-side: it is the audit record of what was matched, and a
  // client-supplied one could say anything.
  const p = new URL("/rest/v1/sds_inventory_products", env.SUPABASE_URL);
  p.searchParams.set("select", "product_name");
  p.searchParams.set("product_id", `eq.${productId}`);
  p.searchParams.set("limit", "1");
  const pr = await fetch(p.toString(), { headers: sbHeaders(env) });
  if (!pr.ok) return jsonError(502, "inventory_products_failed");
  const rows = (await pr.json().catch(() => [])) as { product_name: string }[];
  const inventoryName = rows[0]?.product_name;
  if (!inventoryName) return jsonError(404, "inventory_product_not_found");

  const res = await linkAlias(env, {
    catalogId,
    sourceProductId: productId,
    inventoryName,
    email: g.email
  });
  if (!res.ok) {
    if (res.code === "already_linked") {
      // Say WHERE it already points. "Conflict" leaves an admin with nowhere to
      // go; "that code is already Flash Wax White" is actionable.
      const other = res.existingCatalogId
        ? await readCatalogEntry(env, res.existingCatalogId)
        : null;
      return json(
        {
          error: "already_linked",
          existing_catalog_id: res.existingCatalogId ?? null,
          existing_product_identifier: other?.product_identifier ?? null
        },
        409
      );
    }
    return jsonError(500, "alias_write_failed");
  }
  return json({ alias: res.alias, catalog: entry }, 201);
}

/** Undo a link. A wrong match is the failure that matters, so reversing one has
 *  to be no harder than making it. */
export async function handleUnlinkAlias(
  env: Env,
  req: Request,
  catalogId: string,
  productId: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;
  if (!UUID_RE.test(catalogId) || !UUID_RE.test(productId)) {
    return jsonError(400, "bad_id");
  }
  const removed = await unlinkAlias(env, catalogId, productId);
  if (!removed) return jsonError(404, "alias_not_found");
  return json({ ok: true });
}

// =============================================================================
// POST /forms/api/sds/number-tabs   {location_code, mode}
// =============================================================================

/**
 * Assign the binder's tab numbers.
 *
 * Site-tier, not admin: the person holding the binder is the person filing the
 * sheets, and they are who knows whether the book can be re-tabbed right now.
 *
 * `fill` is safe at any time -- it only numbers what has no number, so it cannot
 * move a sheet already filed. `renumber` rewrites 1..N alphabetically and closes
 * gaps, which DOES invalidate the physical binder; the UI confirms before asking
 * for it, and the response says how many rows moved so the answer is not a
 * silent one.
 */
export async function handleNumberTabs(env: Env, req: Request): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const location = typeof body?.location_code === "string" ? body.location_code : "";
  if (!location || !canRead(g.access, location)) return jsonError(403, "forbidden");

  const mode = body?.mode === "renumber" ? "renumber" : "fill";

  try {
    const result = await assignTabs(env, location, mode, g.email);
    return json({ ...result, tab_limit: TAB_LIMIT });
  } catch (err) {
    console.error("[forms.sds] number tabs failed", err);
    return jsonError(502, "number_tabs_failed");
  }
}

// =============================================================================
// DELETE /forms/api/sds/catalog/{id}
// =============================================================================

/**
 * Remove a catalogue entry outright, for one added in error.
 *
 * Admin-tier, and additionally refused for a VERIFIED entry: a verified badge
 * means somebody accountable checked this, and deleting it is a bigger claim
 * than editing it. Withdraw the verification first -- that way the deletion is
 * two deliberate acts, and the second one happens with the badge already gone.
 *
 * Whether a site holds it is the database's call, not ours (RESTRICT on
 * sds_items.catalog_id). An application-side check could race a site adding the
 * chemical between the check and the delete; the constraint cannot.
 */
export async function handleDeleteCatalog(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_catalog_id");

  const entry = await readCatalogEntry(env, id);
  if (!entry) return jsonError(404, "catalog_entry_not_found");
  if (entry.verified_at) return jsonError(409, "withdraw_verification_first");

  const res = await deleteCatalogEntry(env, id);
  if (!res.ok) {
    if (res.reason === "in_use") {
      // Say how many sites, because the useful next step depends on it: one site
      // that added it by mistake removes it themselves, whereas several mean the
      // entry is real and wants editing rather than deleting.
      const sites = await countSitesUsingCatalog(env, id);
      return json({ error: "catalog_entry_in_use", site_count: sites }, 409);
    }
    if (res.reason === "not_found") return jsonError(404, "catalog_entry_not_found");
    return jsonError(502, "delete_failed");
  }
  return json({ ok: true, deleted: entry.product_identifier });
}

// =============================================================================
// POST /forms/api/sds/catalog/{id}/merge-into   {target_id}
// =============================================================================

/**
 * Fold this entry into another: same chemical, keep the other one.
 *
 * {id} is the entry that GOES. Naming it that way round matches the button --
 * the operator is looking at the wrong row and saying "this one is really that
 * one" -- and the response echoes both names so a misread is visible before
 * anybody trusts it.
 */
export async function handleMergeCatalog(
  env: Env,
  req: Request,
  sourceId: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;
  if (!UUID_RE.test(sourceId)) return jsonError(400, "bad_catalog_id");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const targetId = typeof body?.target_id === "string" ? body.target_id : "";
  if (!UUID_RE.test(targetId)) return jsonError(400, "bad_target_id");

  const source = await readCatalogEntry(env, sourceId);
  const res = await mergeCatalogEntries(env, sourceId, targetId, g.email, readCatalogEntry);
  if (!res.ok) {
    const status =
      res.code === "source_not_found" || res.code === "target_not_found"
        ? 404
        : res.code === "failed"
          ? 502
          : 409;
    return json({ error: res.code }, status);
  }
  return json({
    ok: true,
    merged: source?.product_identifier ?? null,
    into: res.survivor.product_identifier,
    ...res.result
  });
}

// =============================================================================
// GET /forms/api/sds/catalog/{id}/sheet
// =============================================================================

/**
 * Open the sheet attached to a catalogue entry.
 *
 * Any authenticated site user, NOT admin-tier. A safety data sheet is the one
 * thing in this system everybody is entitled to read -- that is the whole point
 * of the OSHA requirement -- and gating it behind curation rights would be
 * exactly backwards. Write access to the catalogue stays admin-only.
 */
export async function handleServeCatalogSheetById(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_catalog_id");

  const entry = await readCatalogEntry(env, id);
  if (!entry) return jsonError(404, "catalog_entry_not_found");
  return handleServeCatalogSheet(env, entry);
}

// =============================================================================
// POST /forms/api/sds/catalog/{id}/hazard   {not_hazardous, note?}
// =============================================================================

/**
 * Record that a chemical does not belong on the HazCom list.
 *
 * OSHA 1910.1200(e)(1)(i) asks for the HAZARDOUS chemicals known to be present,
 * so a product with no hazard at all is not required on it and listing it makes
 * the list longer without making it truer.
 *
 * THE BAR IS HIGHER THAN AN EMPTY "CLASSIFICATION" LINE, and this is the trap.
 * 1910.1200(c) defines a hazardous chemical as one classified as a physical or
 * health hazard, a simple asphyxiant, combustible dust, pyrophoric gas, OR A
 * HAZARD NOT OTHERWISE CLASSIFIED. So a sheet with a blank Classification and
 * "causes mild skin irritation" under HNOC describes a hazardous chemical, and
 * it belongs on the list.
 *
 * Nor does a missing pictogram mean anything: HNOC hazards are disclosed on the
 * SDS and deliberately excluded from label elements, so the most common
 * shortcut -- "no pictogram, must be fine" -- fails on exactly the sheets where
 * being wrong matters. Nothing here can check that; only the person reading
 * section 2 can, which is why the note exists and why this is admin-tier.
 *
 * Admin-tier, the same gate as verification, because it is the same KIND of
 * claim: somebody read the sheet and is answerable for what they concluded. A
 * site keeping its own list must not be able to shorten it by deciding a
 * chemical is safe.
 *
 * The sheet is NOT deleted and the entry is NOT removed. The determination hangs
 * off the chemical so the next person to ask "why isn't this in the book?" finds
 * the answer and the reasoning rather than re-adding it.
 */
export async function handleSetHazard(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;
  if (!UUID_RE.test(id)) return jsonError(400, "bad_catalog_id");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.not_hazardous !== "boolean") return jsonError(400, "not_hazardous_required");
  const notHazardous = body.not_hazardous;
  const note = optionalText(body.note, NOTES_MAX) ?? null;

  const entry = await readCatalogEntry(env, id);
  if (!entry) return jsonError(404, "catalog_entry_not_found");
  if (notHazardous && !entry.sds_r2_key) {
    // The call is a reading of a sheet. Without one there is nothing to have
    // read, and an unevidenced exclusion is the worst row in the catalogue.
    return jsonError(409, "no_sheet_to_assess");
  }

  const updated = await patchCatalogEntry(
    env,
    id,
    notHazardous
      ? {
          not_hazardous: true,
          not_hazardous_at: new Date().toISOString(),
          not_hazardous_by: g.email,
          not_hazardous_note: note,
          updated_by: g.email
        }
      : {
          not_hazardous: false,
          not_hazardous_at: null,
          not_hazardous_by: null,
          not_hazardous_note: null,
          updated_by: g.email
        },
    // This IS the hazard call; do not let the helper clear what it is setting.
    { keepHazardCall: true }
  );
  if (!updated) return jsonError(502, "hazard_update_failed");

  // Its divider is gone, so its number goes with it. A stale tab would keep
  // sorting the chemical among the numbered ones on screen and in print, and
  // point at a divider that now holds something else -- worse than no number.
  if (notHazardous) {
    const u = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
    u.searchParams.set("catalog_id", `eq.${id}`);
    const r = await fetch(u.toString(), {
      method: "PATCH",
      headers: sbHeaders(env, { "Content-Type": "application/json" }),
      body: JSON.stringify({ binder_tab: null, updated_by: g.email })
    });
    if (!r.ok) {
      console.error("[forms.sds] could not clear tabs after hazard call", id, r.status);
    }
  }

  return json({ catalog: updated });
}

// =============================================================================
// GET  /forms/api/sds/safety-documents
// GET  /forms/api/sds/safety-documents/{slug}/file
// POST /forms/api/sds/safety-documents/{slug}/file   (admin, multipart)
// =============================================================================

/** The company safety programmes, uploaded or not. Any authenticated user: the
 *  list is also how somebody sees which ones are still missing. */
export async function handleListSafetyDocs(env: Env, req: Request): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;
  try {
    return json({ documents: await listSafetyDocs(env), can_upload: g.access.isAdmin });
  } catch (err) {
    console.error("[forms.safety-docs] list failed", err);
    return jsonError(502, "safety_documents_failed");
  }
}

/** Open one. Any authenticated user -- a safety programme everybody is meant to
 *  follow is one everybody is meant to be able to read. */
export async function handleServeSafetyDoc(
  env: Env,
  req: Request,
  slug: string
): Promise<Response> {
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await gate(env, req);
  if (!g.ok) return g.response;
  const doc = await readSafetyDoc(env, slug);
  if (!doc) return jsonError(404, "not_found");
  return serveSafetyDoc(env, doc);
}

/**
 * Replace the file behind one document.
 *
 * Admin-tier: this is the company's programme, identical at every site, and a
 * site replacing it for everybody is not a thing a site should be able to do.
 * The row is never created here -- the three exist already -- so an upload can
 * only ever fill or replace a named slot.
 */
export async function handleUploadSafetyDoc(
  env: Env,
  req: Request,
  slug: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const keyed = requireServiceKey(env);
  if (keyed) return keyed;
  const g = await adminGate(env, req);
  if (!g.ok) return g.response;

  const doc = await readSafetyDoc(env, slug);
  if (!doc) return jsonError(404, "not_found");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "invalid_form_data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "no_file");
  if (file.size > SAFETY_DOC_MAX_BYTES) return jsonError(413, "file_too_large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(await isPdf(bytes))) return jsonError(415, "not_a_pdf");

  const key = safetyDocKey(doc.slug);
  try {
    await env.FORMS_FILES.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" }
    });
  } catch (err) {
    console.error("[forms.safety-docs] r2 put failed", key, err);
    return jsonError(502, "upload_failed");
  }

  // R2 first, then the row: the reverse order would leave the row claiming a
  // file that is not there, which reads to a site as a broken link rather than
  // as a missing document.
  const url = new URL("/rest/v1/safety_documents", env.SUPABASE_URL);
  url.searchParams.set("slug", `eq.${doc.slug}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: sbHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      r2_key: key,
      file_name: file.name || `${doc.slug}.pdf`,
      size_bytes: bytes.length,
      uploaded_at: new Date().toISOString(),
      uploaded_by: g.email,
      updated_at: new Date().toISOString(),
      updated_by: g.email
    })
  });
  if (!resp.ok) {
    console.error("[forms.safety-docs] row update failed", resp.status);
    return jsonError(502, "upload_recorded_failed");
  }
  return json({ ok: true, slug: doc.slug, size_bytes: bytes.length });
}
