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
import { getLocationOptionsFromPricingSimple } from "../db/forms.js";

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
  product_identifier: string;
  manufacturer: string | null;
  work_area: string | null;
  source_product_id: string | null;
  sort_order: number;
  notes: string | null;
  is_active: boolean;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

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
  url.searchParams.set("select", "*");
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
  q.searchParams.set("select", "*");
  q.searchParams.set("order", "location_code.asc,sort_order.asc,product_identifier.asc");
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

  const identifier = optionalText(body.product_identifier, IDENTIFIER_MAX);
  if (!identifier) return jsonError(400, "product_identifier_required");

  const row = {
    location_code: location,
    product_identifier: identifier,
    manufacturer: optionalText(body.manufacturer, FIELD_MAX) ?? null,
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
  if (resp.status === 409) {
    // The partial unique index. Same chemical, same work area, already active.
    return jsonError(409, "duplicate_active_item");
  }
  if (!resp.ok) {
    console.error("[forms.sds] create failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "create_failed");
  }
  const created = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json({ item: created[0] ?? null }, 201);
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

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: g.email };

  if (body.product_identifier !== undefined) {
    const v = optionalText(body.product_identifier, IDENTIFIER_MAX);
    if (!v) return jsonError(400, "product_identifier_required");
    patch.product_identifier = v;
  }
  for (const [key, max] of [
    ["manufacturer", FIELD_MAX],
    ["work_area", FIELD_MAX],
    ["notes", NOTES_MAX],
    ["binder_tab", 20]
  ] as const) {
    const v = optionalText(body[key], max);
    if (v !== undefined) patch[key] = v;
  }
  if (typeof body.sort_order === "number" && Number.isFinite(body.sort_order)) {
    patch.sort_order = Math.trunc(body.sort_order);
  }
  // Removal is soft and STAMPED here rather than by the caller, so a row can
  // never claim it left on a date nobody recorded. Restoring clears the stamp,
  // which is what makes the partial unique index let it back in.
  if (typeof body.is_active === "boolean" && body.is_active !== existing.is_active) {
    patch.is_active = body.is_active;
    patch.removed_at = body.is_active ? null : new Date().toISOString();
    patch.removed_by = body.is_active ? null : g.email;
  }

  if (Object.keys(patch).length === 2) return json({ item: existing, unchanged: true });

  const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify(patch)
  });
  if (resp.status === 409) return jsonError(409, "duplicate_active_item");
  if (!resp.ok) {
    console.error("[forms.sds] patch failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "patch_failed");
  }
  const rows = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json({ item: rows[0] ?? null });
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
  existing.searchParams.set("select", "source_product_id,product_identifier");
  existing.searchParams.set("location_code", `eq.${location}`);
  existing.searchParams.set("is_active", "eq.true");
  const er = await fetch(existing.toString(), { headers: sbHeaders(env) });
  const taken = er.ok
    ? ((await er.json().catch(() => [])) as {
        source_product_id: string | null;
        product_identifier: string;
      }[])
    : [];
  const takenIds = new Set(taken.map((t) => t.source_product_id).filter(Boolean));
  const takenNames = new Set(taken.map((t) => t.product_identifier.trim().toLowerCase()));

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

  const rows = found.map((f, i) => ({
    location_code: location,
    product_identifier: f.product_name.slice(0, IDENTIFIER_MAX),
    source_product_id: f.product_id,
    sort_order: i,
    created_by: g.email,
    updated_by: g.email
  }));

  const resp = await fetch(new URL("/rest/v1/sds_items", env.SUPABASE_URL).toString(), {
    method: "POST",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      // A chemical already on the list is not an error worth failing the whole
      // batch over -- the picker filters them out, but two people seeding at
      // once would otherwise lose the second batch entirely.
      Prefer: "return=representation,resolution=ignore-duplicates"
    }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    console.error("[forms.sds] seed failed", resp.status, await resp.text().catch(() => ""));
    return jsonError(502, "seed_failed");
  }
  const created = (await resp.json().catch(() => [])) as SdsItemRow[];
  return json({ items: created, requested: ids.length, created: created.length }, 201);
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
  q.searchParams.set("select", "*");
  q.searchParams.set("location_code", `eq.${location}`);
  q.searchParams.set("is_active", "eq.true");
  q.searchParams.set("order", "sort_order.asc,product_identifier.asc");
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
    items,
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
