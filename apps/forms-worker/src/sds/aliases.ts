// Which inventory products mean the same chemical.
//
// Inventory carries one product per purchasing code, so "Flash Wax White" and
// "DS-FWW-CS" are two rows for one jug on the floor. The SKU is never printed on
// a container and is never a valid entry on an OSHA list -- 1910.1200(e)(1)(i)
// wants the identity that appears on the safety data sheet. So a purchasing code
// RESOLVES to a chemical; it never becomes one.
//
// NO AUTOMATIC MATCHING LIVES HERE, deliberately. "DS-FWW-CS" and "Flash Wax
// White" share no characters, so nothing but a person knows they are the same
// jug -- and on safety data a confident wrong match attaches the wrong hazard
// information to something somebody handles. Shape heuristics are no better:
// UF540, X55 and SAE30 are all real chemicals whose names look like codes. Every
// link in this table was made by a named human, which is the whole point of
// added_by.

import type { Env } from "../index.js";

export interface SdsAliasRow {
  id: string;
  catalog_id: string;
  source_product_id: string;
  inventory_name: string;
  added_by: string;
  added_at: string;
}

function sbHeaders(env: Env, extra?: Record<string, string>) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(extra ?? {})
  };
}

/**
 * product_id -> catalog_id for every aliased product.
 *
 * Returned as a map rather than per-product lookups because both callers -- the
 * picker listing and the bulk create -- need the whole set at once, and asking
 * once is the difference between one request and four hundred.
 */
export async function loadAliasMap(env: Env): Promise<Map<string, string>> {
  const url = new URL("/rest/v1/sds_catalog_aliases", env.SUPABASE_URL);
  url.searchParams.set("select", "catalog_id,source_product_id");
  url.searchParams.set("limit", "5000");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    // Throw rather than returning empty. An empty map reads as "nothing is
    // aliased", which would present every already-resolved purchasing code as a
    // brand-new chemical -- inviting exactly the duplicate this table prevents.
    throw new Error(`alias map read failed: ${resp.status}`);
  }
  const rows = (await resp.json().catch(() => [])) as {
    catalog_id: string;
    source_product_id: string;
  }[];
  return new Map(rows.map((r) => [r.source_product_id, r.catalog_id]));
}

/** The catalogue entry this inventory product resolves to, if a person has said. */
export async function resolveByProduct(
  env: Env,
  sourceProductId: string
): Promise<string | null> {
  const url = new URL("/rest/v1/sds_catalog_aliases", env.SUPABASE_URL);
  url.searchParams.set("select", "catalog_id");
  url.searchParams.set("source_product_id", `eq.${sourceProductId}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as { catalog_id: string }[];
  return rows[0]?.catalog_id ?? null;
}

export type LinkOutcome =
  | { ok: true; alias: SdsAliasRow }
  | { ok: false; code: "already_linked" | "write_failed"; existingCatalogId?: string };

/**
 * Record that an inventory product is this chemical.
 *
 * Refuses when the product already resolves somewhere. The unique constraint
 * would refuse anyway, but a 409 carrying WHERE it currently points lets the
 * caller say "that code is already Flash Wax White" instead of "conflict",
 * which is the difference between a fixable answer and a dead end.
 */
export async function linkAlias(
  env: Env,
  input: {
    catalogId: string;
    sourceProductId: string;
    inventoryName: string;
    email: string;
  }
): Promise<LinkOutcome> {
  const already = await resolveByProduct(env, input.sourceProductId);
  if (already) {
    return already === input.catalogId
      ? { ok: false, code: "already_linked", existingCatalogId: already }
      : { ok: false, code: "already_linked", existingCatalogId: already };
  }

  const resp = await fetch(
    new URL("/rest/v1/sds_catalog_aliases", env.SUPABASE_URL).toString(),
    {
      method: "POST",
      headers: sbHeaders(env, {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      }),
      body: JSON.stringify({
        catalog_id: input.catalogId,
        source_product_id: input.sourceProductId,
        inventory_name: input.inventoryName,
        added_by: input.email
      })
    }
  );
  if (resp.status === 409) {
    const raced = await resolveByProduct(env, input.sourceProductId);
    return { ok: false, code: "already_linked", existingCatalogId: raced ?? undefined };
  }
  if (!resp.ok) {
    console.error(
      "[forms.sds] alias insert failed",
      resp.status,
      await resp.text().catch(() => "")
    );
    return { ok: false, code: "write_failed" };
  }
  const rows = (await resp.json().catch(() => [])) as SdsAliasRow[];
  const alias = rows[0];
  if (!alias) return { ok: false, code: "write_failed" };
  return { ok: true, alias };
}

/** Undo a link. Wrong matches are the failure mode that matters here, so getting
 *  out of one has to be as easy as getting into it. */
export async function unlinkAlias(
  env: Env,
  catalogId: string,
  sourceProductId: string
): Promise<boolean> {
  const url = new URL("/rest/v1/sds_catalog_aliases", env.SUPABASE_URL);
  url.searchParams.set("catalog_id", `eq.${catalogId}`);
  url.searchParams.set("source_product_id", `eq.${sourceProductId}`);
  const resp = await fetch(url.toString(), {
    method: "DELETE",
    headers: sbHeaders(env, { Prefer: "return=representation" })
  });
  if (!resp.ok) return false;
  const rows = (await resp.json().catch(() => [])) as SdsAliasRow[];
  return rows.length > 0;
}

/** Every purchasing code that resolves to this chemical, for the admin page. */
export async function listAliasesForCatalog(
  env: Env,
  catalogId: string
): Promise<SdsAliasRow[]> {
  const url = new URL("/rest/v1/sds_catalog_aliases", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("catalog_id", `eq.${catalogId}`);
  url.searchParams.set("order", "inventory_name.asc");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return [];
  return (await resp.json().catch(() => [])) as SdsAliasRow[];
}
