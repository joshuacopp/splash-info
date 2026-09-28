// The chemical catalogue: what a product IS, shared by every site that holds it.
//
// WHY IT EXISTS. Manufacturer and the safety data sheet are properties of the
// PRODUCT, not of the site. They used to live on the per-site row, which meant
// the same sheet would be uploaded once per site: measured on the first site
// loaded, its 16 products appear across 402 site-rows, so 16 PDFs would have
// become 402 uploads -- and a revision would have meant redoing all of them.
//
// IDENTITY IS NAME + MANUFACTURER. Two sites buying the "same" product from
// different manufacturers genuinely hold different sheets and must not collapse
// onto one row. Matching is case-insensitive and trimmed, because the same
// product typed at two sites will differ in exactly those ways and nothing else.

import type { Env } from "../index.js";
import { linkAlias, resolveByProduct } from "./aliases.js";

export interface SdsCatalogRow {
  id: string;
  product_identifier: string;
  manufacturer: string | null;
  sds_r2_key: string | null;
  sds_filename: string | null;
  sds_size_bytes: number | null;
  sds_uploaded_at: string | null;
  sds_uploaded_by: string | null;
  source_url: string | null;
  sds_revision_date: string | null;
  /** @deprecated superseded by sds_catalog_aliases; no longer written. */
  source_product_id: string | null;
  verified_at: string | null;
  verified_by: string | null;
  /** SDS on file, but not classified as hazardous -- kept out of the printed
   *  HazCom list and the binder. See the column comment in Supabase. */
  not_hazardous: boolean;
  not_hazardous_at: string | null;
  not_hazardous_by: string | null;
  not_hazardous_note: string | null;
}

function sbHeaders(env: Env, extra?: Record<string, string>) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(extra ?? {})
  };
}

/** PostgREST `ilike` with no wildcards is case-insensitive equality -- which is
 *  what we want -- but a name containing % or _ would become a pattern. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function findById(env: Env, id: string): Promise<SdsCatalogRow | null> {
  const url = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  return rows[0] ?? null;
}

async function findByIdentity(
  env: Env,
  identifier: string,
  manufacturer: string | null
): Promise<SdsCatalogRow | null> {
  const url = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("product_identifier", `ilike.${escapeLike(identifier)}`);
  // A missing manufacturer is a distinct identity from any present one, so it
  // has to be matched as null rather than skipped -- otherwise the first row
  // with any manufacturer would be returned for a nameless one.
  url.searchParams.set(
    "manufacturer",
    manufacturer ? `ilike.${escapeLike(manufacturer)}` : "is.null"
  );
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  return rows[0] ?? null;
}

/**
 * The catalogue row for this product, creating it if this is the first site to
 * hold it.
 *
 * Find, then insert, then find again on conflict. PostgREST's `on_conflict`
 * takes column names and the uniqueness here is on EXPRESSIONS
 * (lower(btrim(...))), which it cannot reference -- so the race is handled the
 * honest way instead: two sites adding the same chemical at the same moment,
 * one insert wins, the loser reads the winner's row rather than erroring at
 * somebody who did nothing wrong.
 */
export async function findOrCreateCatalogEntry(
  env: Env,
  input: {
    product_identifier: string;
    manufacturer?: string | null;
    source_product_id?: string | null;
    email: string;
  }
): Promise<SdsCatalogRow | null> {
  const identifier = input.product_identifier.trim();
  const manufacturer = input.manufacturer?.trim() || null;
  if (!identifier) return null;

  // PROVENANCE FIRST, and it has to be. (name, manufacturer) is a weaker
  // identity than it looks: the same inventory product arrives with a
  // manufacturer from one path and without one from another, the pair fails to
  // match, and a second row is inserted for one chemical. That is not
  // hypothetical -- it is how "Bug Remover *2X*" ended up in the catalogue
  // twice, both rows pointing at the same inventory product, 82 minutes apart.
  //
  // The alias table is the provenance record, not sds_catalog.source_product_id,
  // which it supersedes: one chemical can be stocked under several purchasing
  // codes and a single column cannot say so.
  if (input.source_product_id) {
    const aliasedTo = await resolveByProduct(env, input.source_product_id);
    if (aliasedTo) {
      const row = await findById(env, aliasedTo);
      if (row) return row;
    }
  }

  const existing = await findByIdentity(env, identifier, manufacturer);
  if (existing) {
    // Already catalogued under a name somebody typed. Record the provenance so
    // the next pass resolves it without relying on the name matching again.
    if (input.source_product_id) {
      await linkAlias(env, {
        catalogId: existing.id,
        sourceProductId: input.source_product_id,
        inventoryName: identifier,
        email: input.email
      });
    }
    return existing;
  }

  const resp = await fetch(new URL("/rest/v1/sds_catalog", env.SUPABASE_URL).toString(), {
    method: "POST",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify({
      product_identifier: identifier,
      manufacturer,
      created_by: input.email,
      updated_by: input.email
    })
  });
  if (resp.status === 409) return findByIdentity(env, identifier, manufacturer);
  if (!resp.ok) {
    console.error("[forms.sds] catalog insert failed", resp.status, await resp.text().catch(() => ""));
    return null;
  }
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  const created = rows[0];
  if (!created) return null;

  // Provenance goes in the alias table, never back onto the retired column.
  // Failing here leaves a usable catalogue entry that simply is not yet linked
  // to its purchasing code -- recoverable from the picker, so it must not
  // discard the row somebody just created.
  if (input.source_product_id) {
    const linked = await linkAlias(env, {
      catalogId: created.id,
      sourceProductId: input.source_product_id,
      inventoryName: identifier,
      email: input.email
    });
    if (!linked.ok) {
      console.warn(
        "[forms.sds] catalog row created but alias not recorded",
        created.id,
        linked.code
      );
    }
  }
  return created;
}

/** Fields whose change invalidates a verification, because a verification is a
 *  claim about a SPECIFIC identity and a SPECIFIC sheet. */
/** Changing any of these means the attached file is not the one a hazard call
 *  was made against. */
const SHEET_FIELDS = ["sds_r2_key", "sds_filename", "sds_revision_date"] as const;

const VERIFIED_FIELDS = [
  "product_identifier",
  "manufacturer",
  "sds_r2_key",
  "sds_filename",
  "sds_revision_date"
] as const;

/**
 * Update the shared record. Every site holding this chemical sees it.
 *
 * ANY EDIT TO THE IDENTITY OR THE SHEET CLEARS VERIFICATION. A verified badge
 * says somebody checked that this name matches a real sheet and that the
 * attached file is that chemical's; rename it or swap the file afterwards and
 * the badge is vouching for something nobody looked at. A stale assurance on a
 * compliance record is worse than none, and re-verifying is one click.
 *
 * The caller can override with `keepVerification` -- used by the verify
 * endpoint itself, which is setting the badge rather than invalidating it.
 */
export async function patchCatalogEntry(
  env: Env,
  id: string,
  body: Record<string, unknown>,
  opts: { keepVerification?: boolean; keepHazardCall?: boolean } = {}
): Promise<SdsCatalogRow | null> {
  if (!opts.keepVerification && VERIFIED_FIELDS.some((f) => f in body)) {
    body = { ...body, verified_at: null, verified_by: null };
  }
  // A "not hazardous" call is a reading of ONE revision of ONE sheet. Swap the
  // file and nobody has read the new one -- and the failure mode is a chemical
  // that IS hazardous silently staying off the list. Renaming the product does
  // not touch it, because the classification did not change.
  if (!opts.keepHazardCall && SHEET_FIELDS.some((f) => f in body)) {
    body = {
      ...body,
      not_hazardous: false,
      not_hazardous_at: null,
      not_hazardous_by: null,
      not_hazardous_note: null
    };
  }
  const url = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() })
  });
  if (!resp.ok) {
    console.error("[forms.sds] catalog patch failed", resp.status);
    return null;
  }
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  return rows[0] ?? null;
}

export async function readCatalogEntry(
  env: Env,
  id: string
): Promise<SdsCatalogRow | null> {
  const url = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  return rows[0] ?? null;
}

/**
 * How many ACTIVE sites hold this chemical.
 *
 * Surfaced so the UI can say what an edit actually does before somebody does
 * it. Replacing a sheet is a good thing that touches every binder holding the
 * product, and the difference between that being a feature and a nasty surprise
 * is entirely whether the number was on screen first.
 */
export async function countSitesUsingCatalog(
  env: Env,
  catalogId: string
): Promise<number> {
  const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  url.searchParams.set("select", "id");
  url.searchParams.set("catalog_id", `eq.${catalogId}`);
  url.searchParams.set("is_active", "eq.true");
  const resp = await fetch(url.toString(), {
    method: "HEAD",
    headers: sbHeaders(env, { Prefer: "count=exact" })
  });
  const range = resp.headers.get("content-range");
  const total = range?.split("/")[1];
  return total && total !== "*" ? Number(total) : 0;
}

export interface CatalogSearchRow extends SdsCatalogRow {
  /** How many sites already hold it. Not authority, but it is the cheapest
   *  signal of "this is the entry everyone else uses" when several look alike. */
  site_count: number;
  /** Purchasing codes that resolve here. Shown so a wrong link is VISIBLE on the
   *  row rather than only discoverable by opening the inventory picker and
   *  noticing something is missing from it. */
  aliases: { source_product_id: string; inventory_name: string; added_by: string }[];
  /** False when a site holds it, in which case the database refuses the delete
   *  (sds_items.catalog_id is RESTRICT). Computed here so the button can be
   *  disabled with a reason instead of failing on click. */
  deletable: boolean;
}

/**
 * Search the shared catalogue.
 *
 * THE POINT OF THE WHOLE THING: fifty sites hold unleaded gasoline and it is one
 * chemical with one sheet. A site adding it should find the entry somebody
 * already made, not type it in again and produce a fifty-first near-duplicate
 * that nobody can tell apart on a printed index.
 *
 * Verified entries sort first because they are the ones a site should reach for.
 * Unverified ones are still offered -- a site needing something nobody has got
 * to yet must not be stuck waiting for an administrator.
 */
export async function searchCatalog(
  env: Env,
  opts: { q?: string; verifiedOnly?: boolean; limit?: number }
): Promise<CatalogSearchRow[]> {
  const url = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", String(Math.min(opts.limit ?? 50, 200)));
  // Verified first, then most recently touched. A plain name sort would bury
  // the entry fifty sites use under a typo somebody made once.
  url.searchParams.set("order", "verified_at.desc.nullslast,updated_at.desc");
  if (opts.verifiedOnly) url.searchParams.set("verified_at", "not.is.null");

  const q = opts.q?.trim();
  if (q) {
    const term = `*${escapeLike(q)}*`;
    // Either field: people search by what is on the drum, which is sometimes
    // the product and sometimes the maker.
    url.searchParams.set(
      "or",
      `(product_identifier.ilike.${term},manufacturer.ilike.${term})`
    );
  }

  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    console.error("[forms.sds] catalog search failed", resp.status);
    return [];
  }
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  if (rows.length === 0) return [];

  // One read for every count rather than one read per row.
  const counts: Record<string, number> = {};
  try {
    const u = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
    u.searchParams.set("select", "catalog_id");
    u.searchParams.set("is_active", "eq.true");
    u.searchParams.set("limit", "20000");
    const ur = await fetch(u.toString(), { headers: sbHeaders(env) });
    if (ur.ok) {
      for (const r of (await ur.json().catch(() => [])) as { catalog_id: string }[]) {
        if (r.catalog_id) counts[r.catalog_id] = (counts[r.catalog_id] ?? 0) + 1;
      }
    }
  } catch (err) {
    // A missing count costs a hint, not the feature.
    console.error("[forms.sds] catalog search counts failed", err);
  }

  // Counts above are ACTIVE items only, because that is what "used at N sites"
  // means to a reader. Deletability is a different question and needs ANY item,
  // active or removed: sds_items.catalog_id is RESTRICT, so a removed row still
  // blocks the delete, and a button that looked enabled would just fail.
  const held = new Set<string>();
  try {
    const u = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
    u.searchParams.set("select", "catalog_id");
    u.searchParams.set("limit", "20000");
    const ur = await fetch(u.toString(), { headers: sbHeaders(env) });
    if (ur.ok) {
      for (const r of (await ur.json().catch(() => [])) as { catalog_id: string }[]) {
        if (r.catalog_id) held.add(r.catalog_id);
      }
    }
  } catch (err) {
    console.error("[forms.sds] catalog search held-set failed", err);
  }

  const aliasesBy: Record<
    string,
    { source_product_id: string; inventory_name: string; added_by: string }[]
  > = {};
  try {
    const a = new URL("/rest/v1/sds_catalog_aliases", env.SUPABASE_URL);
    a.searchParams.set("select", "catalog_id,source_product_id,inventory_name,added_by");
    a.searchParams.set("order", "inventory_name.asc");
    a.searchParams.set("limit", "5000");
    const ar = await fetch(a.toString(), { headers: sbHeaders(env) });
    if (ar.ok) {
      for (const r of (await ar.json().catch(() => [])) as {
        catalog_id: string;
        source_product_id: string;
        inventory_name: string;
        added_by: string;
      }[]) {
        (aliasesBy[r.catalog_id] ??= []).push({
          source_product_id: r.source_product_id,
          inventory_name: r.inventory_name,
          added_by: r.added_by
        });
      }
    }
  } catch (err) {
    console.error("[forms.sds] catalog search aliases failed", err);
  }

  return rows.map((r) => ({
    ...r,
    site_count: counts[r.id] ?? 0,
    aliases: aliasesBy[r.id] ?? [],
    deletable: !held.has(r.id)
  }));
}

/**
 * Delete a catalogue entry.
 *
 * Nothing here checks whether a site holds it -- sds_items.catalog_id is
 * RESTRICT, so the DATABASE refuses, and that refusal is the guarantee worth
 * relying on. A check in application code could race with a site adding the
 * chemical a moment later; the constraint cannot.
 *
 * Its aliases go with it (CASCADE), which is right: they described this entry's
 * identity and mean nothing without it.
 */
export async function deleteCatalogEntry(
  env: Env,
  id: string
): Promise<{ ok: true } | { ok: false; reason: "in_use" | "not_found" | "failed" }> {
  const url = new URL("/rest/v1/sds_catalog", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), {
    method: "DELETE",
    headers: sbHeaders(env, { Prefer: "return=representation" })
  });
  if (resp.status === 409) return { ok: false, reason: "in_use" };
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // 23503 is the FK violation RESTRICT raises. PostgREST does not always
    // surface it as 409, so match the code too rather than reporting a generic
    // failure for the one case that has a real explanation.
    if (body.includes("23503")) return { ok: false, reason: "in_use" };
    console.error("[forms.sds] catalog delete failed", resp.status, body);
    return { ok: false, reason: "failed" };
  }
  const rows = (await resp.json().catch(() => [])) as SdsCatalogRow[];
  return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

/**
 * Mark a catalogue entry verified, or withdraw it.
 *
 * Verification says: this entry names a real chemical the way its sheet names
 * it, and the attached sheet is that chemical's. It is deliberately NOT a
 * property a site can set for itself -- the whole value is that it was checked
 * by somebody accountable for checking.
 */
export async function setCatalogVerified(
  env: Env,
  id: string,
  verified: boolean,
  email: string
): Promise<SdsCatalogRow | null> {
  return patchCatalogEntry(
    env,
    id,
    verified
      ? { verified_at: new Date().toISOString(), verified_by: email }
      : { verified_at: null, verified_by: null },
    // Setting the badge, not invalidating it.
    { keepVerification: true }
  );
}
