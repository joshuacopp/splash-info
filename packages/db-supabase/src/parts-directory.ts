// Parts Directory reads + writes — backs `public.parts_directory`.
//
// DDL lives in supabase/parts-directory-01-tables.sql, amended by
// supabase/parts-directory-02-multi-equipment.sql. RLS is ON with no
// policies, so every call here MUST come through the service-role client
// (`createServiceClient`); the anon / authenticated roles see nothing. The
// only caller today is splash-workorders (`/workorders/api/parts/*`) —
// apps/web has no Supabase bindings and reaches the data through the
// WORKORDERS_WORKER service binding.
//
// NOT SCOPED BY LOCATION. Unlike the work-order read path in the same
// worker (email-on-locations), the directory is a single shared reference
// list: any authenticated user reads all of it. `location_codes` on a row
// is descriptive metadata ("which sites use this part"), not an ACL.
//
// MULTI-EQUIPMENT: `parent_equipment` is a `text[]` (NOT NULL DEFAULT '{}'),
// not a single machine name. One manufacturer part — a bearing, a motor, a
// cylinder — is usually shared by the wrap, the top brush and the conveyor,
// and operators should enter it once. An empty array is legal and means
// "not yet assigned to a machine".
//
// Uniqueness moved with the column: the duplicate the DB now blocks is
// `uq_parts_directory_number_per_vendor` — the same vendor's same part
// number entered twice — not "same number on the same machine".
//
// PHOTOS: only the R2 key is persisted (`photo_r2_key`, in the existing
// `splash-parts-manuals` bucket). Nothing in this module touches R2 —
// `deletePart` hands the key back so the caller can decide whether to
// clean up the orphaned object.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Every column, as PostgREST returns it. */
const PARTS_COLS =
  "id,parent_equipment,part_name,part_number,vendor,photo_r2_key,unit_cost,vendor_url,location_codes,notes,created_at,created_by,updated_at,updated_by";

export interface PartsDirectoryRow {
  id: string;
  /** Every machine this part is used on. `[]` = unassigned. */
  parent_equipment: string[];
  part_name: string;
  part_number: string | null;
  vendor: string | null;
  photo_r2_key: string | null;
  unit_cost: number | null;
  vendor_url: string | null;
  location_codes: string[];
  notes: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/**
 * The nine writable columns. `id` / `created_at` / `updated_at` are server-
 * owned (PK default, column default, and the `trg_parts_directory_updated_at`
 * trigger respectively) and are deliberately absent from this type — a caller
 * cannot set them even by accident, because the write builders below copy
 * fields explicitly rather than spreading the input.
 *
 * Everything is optional here so the same shape serves PATCH. `createPart`
 * narrows `parent_equipment` + `part_name` to required at its own signature.
 */
export interface PartsDirectoryInput {
  parent_equipment?: string[];
  part_name?: string;
  part_number?: string | null;
  vendor?: string | null;
  photo_r2_key?: string | null;
  unit_cost?: number | null;
  vendor_url?: string | null;
  location_codes?: string[];
  notes?: string | null;
}

/** `createPart` / `updatePart` narrow the create case to these two required. */
export type PartsDirectoryCreateInput = PartsDirectoryInput & {
  /** May be `[]` — a part can be catalogued before anyone knows what it fits. */
  parent_equipment: string[];
  part_name: string;
};

/* ============================================================
 * Unique-violation surfacing
 * ============================================================ */

/**
 * Thrown when a write trips `uq_parts_directory_number_per_vendor` — the
 * partial UNIQUE index on `(lower(coalesce(vendor,'')), lower(part_number))`
 * for rows with a non-empty part number.
 *
 * Since parts-directory-02 the duplicate rule is per VENDOR, not per machine:
 * one part can now list many machines, so "same number on the same equipment"
 * stopped describing a duplicate. Rows with no vendor coalesce to '', so two
 * vendorless entries of the same number still collide.
 *
 * This exists so the worker can answer 409 instead of a generic 500. Two
 * admins editing the same bench at once is an ordinary, recoverable thing;
 * it should not read as a server fault. Postgres 23505 is the only code we
 * translate — every other PostgrestError is rethrown untouched, matching the
 * `if (error.code !== "23505") throw error` pattern used in greeter.ts /
 * expense.ts.
 */
export class PartsDirectoryConflictError extends Error {
  /** Discriminator that survives bundling — prefer `isPartsDirectoryConflict`
   *  over `instanceof` at call sites in other packages. */
  readonly code = "parts_directory_conflict" as const;
  readonly pgCode = "23505" as const;

  constructor(message = "This vendor already has a part with that part number.") {
    super(message);
    this.name = "PartsDirectoryConflictError";
  }
}

/** Structural check — safe across package/bundle boundaries. */
export function isPartsDirectoryConflict(err: unknown): err is PartsDirectoryConflictError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "parts_directory_conflict"
  );
}

/** Rethrow helper: 23505 → typed conflict, anything else → as-is. */
function throwMapped(error: { code?: string | null; message?: string | null }): never {
  if (error.code === "23505") throw new PartsDirectoryConflictError();
  throw error;
}

/* ============================================================
 * Normalization
 * ============================================================ */

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * PostgREST hands `numeric(10,2)` back as a JSON number, but it can arrive as
 * a string depending on the driver/serializer in play. Coerce defensively and
 * drop anything non-finite.
 */
function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Canonical shape for `parent_equipment` on the way IN: trim each entry, drop
 * blanks, and dedupe case-insensitively while keeping the FIRST spelling the
 * caller used and the caller's ordering. "Top Brush" and "top brush" are the
 * same machine to an operator, so storing both would split the filter
 * dropdown in two; but whichever capitalisation they typed first is the one
 * that shows up in the UI, so we keep it rather than folding to lower case
 * (unlike `location_codes`, which are opaque site codes and are lowercased).
 *
 * `[]` is a legitimate value and matches the column default.
 */
function normalizeEquipment(value: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Escape one value for a PostgREST text[] literal (`{a,b,c}`), used as the
 * argument to the `cs` (contains) operator. postgrest-js builds that literal
 * with a bare `value.join(",")` and does NOT quote the members, so an
 * equipment name containing a comma, brace, quote or backslash would silently
 * become two array elements — or a 400. Whitespace is quoted too, which is the
 * common case here ("Top Brush" -> "\"Top Brush\""); Postgres would actually
 * parse the unquoted form, but quoting it is unambiguous.
 */
function escapePgrstArrayLiteral(value: string): string {
  if (/[,{}"\\\s]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function normalizeRow(raw: unknown): PartsDirectoryRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  return {
    id: r.id,
    parent_equipment: Array.isArray(r.parent_equipment)
      ? r.parent_equipment.filter((e): e is string => typeof e === "string")
      : [],
    part_name: typeof r.part_name === "string" ? r.part_name : "",
    part_number: toStringOrNull(r.part_number),
    vendor: toStringOrNull(r.vendor),
    photo_r2_key: toStringOrNull(r.photo_r2_key),
    unit_cost: toNumberOrNull(r.unit_cost),
    vendor_url: toStringOrNull(r.vendor_url),
    location_codes: Array.isArray(r.location_codes)
      ? r.location_codes.filter((c): c is string => typeof c === "string")
      : [],
    notes: toStringOrNull(r.notes),
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    created_by: toStringOrNull(r.created_by),
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
    updated_by: toStringOrNull(r.updated_by)
  };
}

/* ============================================================
 * Reads
 * ============================================================ */

/**
 * Strip everything that would break PostgREST's `or=(...)` mini-grammar.
 *
 * The `or` filter is parsed as a comma-separated, parenthesized list, so a
 * literal `,` `(` or `)` inside the search term terminates or nests the
 * expression and produces a 400 (or, worse, a filter the caller didn't
 * write). supabase-js does NOT escape interpolated `or` values — see the
 * same caveat on `listLocationsForUser` in pricing.ts.
 *
 * `*` and `%` are ILIKE wildcards (PostgREST maps `*` → `%`), and `\` is the
 * ILIKE escape character; all three are dropped so a term is always matched
 * as a literal substring. `"` is dropped because PostgREST uses it to quote
 * filter values.
 */
function sanitizeSearchTerm(raw: string): string {
  return raw
    .trim()
    .replace(/[,()*%\\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Columns the `search` param matches as a case-insensitive substring.
 *
 * `parent_equipment` is deliberately NOT here. It is a `text[]`, and ILIKE has
 * no text[] operator — PostgREST answers 400 for `parent_equipment.ilike.*x*`.
 * There is also no index that could serve it: `gin_trgm_ops` cannot index a
 * text[], and wrapping the column in `array_to_string(...)` is rejected
 * because that function is STABLE, not IMMUTABLE (see
 * parts-directory-02-multi-equipment.sql). Substring matching on equipment is
 * therefore done client-side by the page, which is free — `listParts` has no
 * pagination and hands back the whole directory anyway. The exact-value
 * equipment filter below is the indexed path.
 */
const SEARCH_COLS = [
  "part_name",
  "part_number",
  "vendor",
  "notes"
] as const;

export interface ListPartsOptions {
  /** Case-insensitive substring match across SEARCH_COLS. Blank = no filter. */
  search?: string;
  /** Rows whose `parent_equipment` array CONTAINS this exact machine name
   *  (the UI's filter dropdown). Blank = no filter. */
  equipment?: string;
}

/**
 * Whole directory, optionally filtered. Ordered parent_equipment asc then
 * part_name asc; since parent_equipment is a text[], Postgres compares it
 * element-wise, which groups parts that share a first machine together and
 * sorts the unassigned (`{}`) rows first.
 *
 * No pagination: this is a hand-curated reference list in the low hundreds of
 * rows. If it ever outgrows that, add a range() here rather than filtering
 * client-side.
 */
export async function listParts(
  client: SupabaseClient,
  opts: ListPartsOptions = {}
): Promise<PartsDirectoryRow[]> {
  let q = client.from("parts_directory").select(PARTS_COLS);

  const term = typeof opts.search === "string" ? sanitizeSearchTerm(opts.search) : "";
  if (term) {
    q = q.or(SEARCH_COLS.map((col) => `${col}.ilike.*${term}*`).join(","));
  }

  const equipment = typeof opts.equipment === "string" ? opts.equipment.trim() : "";
  if (equipment) {
    // parent_equipment=cs.{"Top Brush"} — array containment, served by
    // idx_parts_directory_equipment_gin. Not `.eq`: the column holds every
    // machine the part fits, so equality would only ever match a part used on
    // exactly this one machine.
    q = q.contains("parent_equipment", [escapePgrstArrayLiteral(equipment)]);
  }

  const { data, error } = await q
    .order("parent_equipment", { ascending: true })
    .order("part_name", { ascending: true });
  if (error) throw error;

  const out: PartsDirectoryRow[] = [];
  for (const raw of data ?? []) {
    const row = normalizeRow(raw);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Every machine named anywhere in the directory: the `parent_equipment`
 * arrays of all rows flattened into one deduped list, sorted
 * case-insensitively. Rows with an empty array contribute nothing.
 *
 * Deliberately computed over EVERY row, never the filtered set — the UI's
 * equipment dropdown must not shrink out from under the operator while they
 * type in the search box. A plain select + JS flatten is correct at this table
 * size; PostgREST has no DISTINCT or UNNEST, and an RPC would be overkill.
 *
 * Dedupe is case-insensitive and keeps the first spelling encountered, which
 * matches `normalizeEquipment` on the write path.
 */
export async function listPartsEquipment(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from("parts_directory")
    .select("parent_equipment");
  if (error) throw error;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of data ?? []) {
    const value = (raw as { parent_equipment?: unknown }).parent_equipment;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Single row by uuid. Returns null when the id doesn't exist. */
export async function getPart(
  client: SupabaseClient,
  id: string
): Promise<PartsDirectoryRow | null> {
  const { data, error } = await client
    .from("parts_directory")
    .select(PARTS_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return normalizeRow(data);
}

/* ============================================================
 * Writes
 * ============================================================ */

/**
 * Copy only the writable columns off an input object. Explicit field-by-field
 * rather than a spread so an attacker-supplied `id` / `created_at` /
 * `updated_at` (or any unknown column) can never reach the table. `undefined`
 * means "not supplied" and is omitted entirely, which is what makes PATCH
 * partial; an explicit `null` clears the column.
 */
function buildWritableBody(input: PartsDirectoryInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.parent_equipment !== undefined) {
    body.parent_equipment = normalizeEquipment(input.parent_equipment);
  }
  if (input.part_name !== undefined) body.part_name = input.part_name;
  if (input.part_number !== undefined) body.part_number = input.part_number;
  if (input.vendor !== undefined) body.vendor = input.vendor;
  if (input.photo_r2_key !== undefined) body.photo_r2_key = input.photo_r2_key;
  if (input.unit_cost !== undefined) body.unit_cost = input.unit_cost;
  if (input.vendor_url !== undefined) body.vendor_url = input.vendor_url;
  if (input.location_codes !== undefined) body.location_codes = input.location_codes;
  if (input.notes !== undefined) body.notes = input.notes;
  return body;
}

/**
 * Insert one part. `created_by` / `updated_by` are set from the caller's
 * session email — never from the request body.
 *
 * Throws `PartsDirectoryConflictError` on the partial unique index (same
 * vendor + same part number, case-insensitive). Caller maps that to 409.
 */
export async function createPart(
  client: SupabaseClient,
  input: PartsDirectoryCreateInput,
  actorEmail: string
): Promise<PartsDirectoryRow> {
  const actor = actorEmail.trim().toLowerCase() || null;
  const body = {
    ...buildWritableBody(input),
    // Both array columns are NOT NULL DEFAULT '{}' — send an explicit empty
    // array when the caller omitted them so the column default and the
    // returned row agree without a re-read.
    parent_equipment: normalizeEquipment(input.parent_equipment ?? []),
    location_codes: input.location_codes ?? [],
    created_by: actor,
    updated_by: actor
  };

  const { data, error } = await client
    .from("parts_directory")
    .insert(body)
    .select(PARTS_COLS)
    .single();
  if (error) throwMapped(error);

  const row = normalizeRow(data);
  if (!row) throw new Error("createPart: insert returned no row");
  return row;
}

/**
 * Partial update. Returns null when `id` matches nothing (caller → 404).
 *
 * `updated_at` is NOT set here — `trg_parts_directory_updated_at` owns it, so
 * a hand-run SQL fix can't leave a stale timestamp behind. `updated_by` is
 * always stamped, even on a no-op body, so "who touched this last" stays
 * truthful.
 */
export async function updatePart(
  client: SupabaseClient,
  id: string,
  input: PartsDirectoryInput,
  actorEmail: string
): Promise<PartsDirectoryRow | null> {
  const body = {
    ...buildWritableBody(input),
    updated_by: actorEmail.trim().toLowerCase() || null
  };

  const { data, error } = await client
    .from("parts_directory")
    .update(body)
    .eq("id", id)
    .select(PARTS_COLS)
    .maybeSingle();
  if (error) throwMapped(error);
  return normalizeRow(data);
}

export interface DeletePartResult {
  /** False when no row matched the id — caller answers 404. */
  deleted: boolean;
  /** R2 key of the deleted row's photo, so the caller can clean up the
   *  now-orphaned object (or deliberately leave it). Null when the row had
   *  no photo, and when nothing was deleted. */
  photo_r2_key: string | null;
}

/**
 * Hard delete. There is no soft-delete column on this table — the directory
 * is reference data, not a record of events, and a wrong row should simply
 * stop existing.
 *
 * The deleted row's `photo_r2_key` comes back via `return=representation` so
 * the caller doesn't need a read-before-delete round trip.
 */
export async function deletePart(
  client: SupabaseClient,
  id: string
): Promise<DeletePartResult> {
  const { data, error } = await client
    .from("parts_directory")
    .delete()
    .eq("id", id)
    .select("id,photo_r2_key")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { deleted: false, photo_r2_key: null };
  return {
    deleted: true,
    photo_r2_key: toStringOrNull((data as { photo_r2_key?: unknown }).photo_r2_key)
  };
}
