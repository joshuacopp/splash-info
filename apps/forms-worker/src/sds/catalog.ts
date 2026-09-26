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
  source_product_id: string | null;
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

  const existing = await findByIdentity(env, identifier, manufacturer);
  if (existing) return existing;

  const resp = await fetch(new URL("/rest/v1/sds_catalog", env.SUPABASE_URL).toString(), {
    method: "POST",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }),
    body: JSON.stringify({
      product_identifier: identifier,
      manufacturer,
      source_product_id: input.source_product_id ?? null,
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
  return rows[0] ?? null;
}

/** Update the shared record. Every site holding this chemical sees it. */
export async function patchCatalogEntry(
  env: Env,
  id: string,
  body: Record<string, unknown>
): Promise<SdsCatalogRow | null> {
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
