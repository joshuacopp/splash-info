// Parts Directory HTTP surface — /workorders/api/parts[/{id}].
//
// WHY THIS LIVES ON splash-workorders. The parts directory is a mechanical-
// group reference list, not a MaintainX object, so it has no natural home in
// this worker's domain. It landed here anyway because this worker already has
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY bound, already
// depends on @splash/auth + @splash/db-supabase + @splash/http, and is already
// reachable from apps/web through the WORKORDERS_WORKER service binding.
// Standing up a whole new worker (plus three secrets, a route, a CF Builds
// config and a service binding) to serve four endpoints would have been pure
// ceremony. Kept in its own file so index.ts stays a single-purpose MaintainX
// reader.
//
// PERMISSION DOMAIN — DELIBERATELY NOT email-on-locations.
// The rest of this worker gates on "is your email on this location's
// am_email / rm_email / site_email row", because a work order belongs to a
// site and only that site's people should see it. The parts directory is the
// opposite kind of data: it is ONE shared list that the whole company reads.
// A tech at any site needs to look up the same idler bearing. So every
// authenticated session reads the entire directory, unfiltered — no location
// gate, no tool grant. The `location_codes` column on a row is descriptive
// ("these sites use this part"), never an ACL; do not start filtering on it.
// Writes are the narrow part: platform super_admin only.
//
// ROLE FIELD. Writes gate on `session.role === "super_admin"` — the platform
// role from `user_permissions` (via the auth_unified view). NOT `session.dcRole`,
// which is the damage-claims workflow role and has nothing to do with parts;
// `isSyncTriggerAllowed` in index.ts uses dcRole because the sync trigger grew
// out of that lineage, and copying it here would mean a damage-claims admin who
// is not a platform admin could edit the directory. This matches how the other
// internal-tooling workers gate their admin surfaces (inventory/worker/auth.ts,
// beekeeper-worker/src/handlers.ts both test `session.role === "super_admin"`).
//
// CSRF. These are JSON endpoints, not the plain-form posts that
// POST /workorders/api/request handles, so `isOriginAllowed` is NOT used here:
// browser writes arrive proxied through apps/web route handlers (service
// binding), where the Origin header does not correspond to this worker's URL
// and the check would reject every legitimate write. The barrier instead is
// the required `Content-Type: application/json` — a cross-site fetch with that
// content type is not a "simple request" and is blocked by the browser's CORS
// preflight, which this worker never answers — plus the SameSite=Lax session
// cookie and the super_admin gate.
//
// PHOTOS. Only `photo_r2_key` is stored. The object itself lives in the
// existing `splash-parts-manuals` R2 bucket, which is bound to apps/web (not to
// this worker), so upload and cleanup are apps/web's job. DELETE hands the
// key back in its response for exactly that reason.

import type { Session } from "@splash/auth";
import {
  createPart,
  createServiceClient,
  deletePart,
  getPart,
  isPartsDirectoryConflict,
  listParts,
  listPartsEquipment,
  updatePart,
  type PartsDirectoryCreateInput,
  type PartsDirectoryInput,
  type PartsDirectoryRow,
  type SupabaseEnv
} from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";

/* ============================================================
 * Response shapes — the apps/web contract.
 * ============================================================ */

interface PartsListResponse {
  ok: true;
  parts: PartsDirectoryRow[];
  /** Distinct sorted `parent_equipment` over EVERY row, not just the
   *  filtered set, so the UI's filter dropdown doesn't collapse as the
   *  operator types in the search box. */
  equipment: string[];
}

interface PartResponse {
  ok: true;
  part: PartsDirectoryRow;
}

interface PartDeleteResponse {
  ok: true;
  /** Non-null when the deleted row had a photo; apps/web owns the R2 delete. */
  photo_r2_key: string | null;
}

/* ============================================================
 * Validation
 * ============================================================ */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous caps — these exist so a runaway paste can't write a megabyte into
// a reference table, not to police operator phrasing.
const MAX_SHORT_TEXT = 200;
const MAX_NOTES = 4000;
const MAX_URL = 2048;
const MAX_R2_KEY = 512;
const MAX_LOCATION_CODES = 200;

/** Thrown by the field readers; caught once per handler → 400. */
class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

/**
 * Nullable free-text field. Absent → undefined (PATCH leaves it alone);
 * explicit null or an all-whitespace string → null (clears the column).
 */
function readOptionalText(
  body: Record<string, unknown>,
  key: string,
  maxLen: number
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string") fail(`${key} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) fail(`${key} is too long (max ${maxLen} characters)`);
  return trimmed;
}

/** Required free-text field (parent_equipment, part_name). */
function readRequiredText(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "string") fail(`${key} is required`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${key} is required`);
  if (trimmed.length > MAX_SHORT_TEXT) {
    fail(`${key} is too long (max ${MAX_SHORT_TEXT} characters)`);
  }
  return trimmed;
}

/**
 * `unit_cost` — a finite number >= 0, or null. Numeric strings are accepted
 * because an HTML number input round-trips as a string through more than one
 * JSON encoder; "" is treated as "cleared", same as null.
 */
function readUnitCost(body: Record<string, unknown>): number | null | undefined {
  if (!("unit_cost" in body)) return undefined;
  const value = body.unit_cost;
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      fail("unit_cost must be a number greater than or equal to 0");
    }
    return parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("unit_cost must be a number greater than or equal to 0");
  }
  return value;
}

/** `vendor_url` — http(s) only. A `javascript:` or `data:` URL would be
 *  rendered as an anchor href by the UI; reject at the door. */
function readVendorUrl(body: Record<string, unknown>): string | null | undefined {
  const raw = readOptionalText(body, "vendor_url", MAX_URL);
  if (raw === undefined || raw === null) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("vendor_url must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("vendor_url must be a valid http(s) URL");
  }
  return raw;
}

/** `location_codes` — array of non-empty strings, lowercased + deduped.
 *  null is accepted and means "empty set" (the column is NOT NULL DEFAULT '{}'). */
function readLocationCodes(body: Record<string, unknown>): string[] | undefined {
  if (!("location_codes" in body)) return undefined;
  const value = body.location_codes;
  if (value === null) return [];
  if (!Array.isArray(value)) fail("location_codes must be an array of strings");
  if (value.length > MAX_LOCATION_CODES) {
    fail(`location_codes has too many entries (max ${MAX_LOCATION_CODES})`);
  }
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") fail("location_codes must be an array of strings");
    const code = entry.trim().toLowerCase();
    if (!code) continue;
    if (code.length > MAX_SHORT_TEXT) fail("location_codes entry is too long");
    out.add(code);
  }
  return [...out];
}

/** Shared field reader for POST (create=true) and PATCH (create=false). */
function readPartsInput(
  body: Record<string, unknown>,
  create: boolean
): PartsDirectoryInput {
  const parentEquipment = readRequiredText(body, "parent_equipment");
  const partName = readRequiredText(body, "part_name");
  if (create) {
    if (parentEquipment === undefined) fail("parent_equipment is required");
    if (partName === undefined) fail("part_name is required");
  }

  const input: PartsDirectoryInput = {};
  if (parentEquipment !== undefined) input.parent_equipment = parentEquipment;
  if (partName !== undefined) input.part_name = partName;

  const partNumber = readOptionalText(body, "part_number", MAX_SHORT_TEXT);
  if (partNumber !== undefined) input.part_number = partNumber;

  const vendor = readOptionalText(body, "vendor", MAX_SHORT_TEXT);
  if (vendor !== undefined) input.vendor = vendor;

  const photoKey = readOptionalText(body, "photo_r2_key", MAX_R2_KEY);
  if (photoKey !== undefined) input.photo_r2_key = photoKey;

  const unitCost = readUnitCost(body);
  if (unitCost !== undefined) input.unit_cost = unitCost;

  const vendorUrl = readVendorUrl(body);
  if (vendorUrl !== undefined) input.vendor_url = vendorUrl;

  const locationCodes = readLocationCodes(body);
  if (locationCodes !== undefined) input.location_codes = locationCodes;

  const notes = readOptionalText(body, "notes", MAX_NOTES);
  if (notes !== undefined) input.notes = notes;

  return input;
}

/** Parse a JSON body into a plain object. Rejects non-JSON content types —
 *  see the CSRF note in the file header, this check is load-bearing. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const ctype = request.headers.get("content-type") ?? "";
  if (!ctype.includes("application/json")) {
    fail("request body must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return fail("request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/* ============================================================
 * Router
 * ============================================================ */

/** Platform super_admin — see the ROLE FIELD note in the file header. */
function isPartsAdmin(session: Session): boolean {
  return session.role === "super_admin";
}

/**
 * Dispatch for `workorders/api/parts` and `workorders/api/parts/{id}`.
 * `path` arrives already stripped of leading slashes by index.ts. The caller
 * has already authenticated; this function owns method routing, the
 * super_admin gate on writes, validation, and status-code mapping.
 */
export async function handlePartsRequest(
  request: Request,
  env: SupabaseEnv,
  path: string,
  session: Session
): Promise<Response> {
  const rest = path.slice("workorders/api/parts".length).replace(/^\/+/, "");
  const method = request.method.toUpperCase();

  // Collection routes.
  if (!rest) {
    if (method === "GET") return handleListParts(request, env);
    if (method === "POST") {
      if (!isPartsAdmin(session)) {
        return jsonError(403, "parts directory writes require super_admin");
      }
      return handleCreatePart(request, env, session);
    }
    return jsonError(405, "method not allowed");
  }

  // Item routes. Anything deeper than one segment is not ours.
  if (rest.includes("/")) return jsonError(404, "not found");
  const id = decodeURIComponent(rest);
  if (!UUID_RE.test(id)) return jsonError(400, "id must be a uuid");

  if (method === "PATCH") {
    if (!isPartsAdmin(session)) {
      return jsonError(403, "parts directory writes require super_admin");
    }
    return handleUpdatePart(request, env, id, session);
  }
  if (method === "DELETE") {
    if (!isPartsAdmin(session)) {
      return jsonError(403, "parts directory writes require super_admin");
    }
    return handleDeletePart(env, id);
  }
  if (method === "GET") {
    // Not part of the published contract, but free: the list route already
    // exposes every row to every session, so a single-row read adds no
    // surface. Handy for debugging a specific id.
    const sb = createServiceClient(env);
    const part = await getPart(sb, id);
    if (!part) return jsonError(404, "part not found");
    return json({ ok: true, part } satisfies PartResponse);
  }
  return jsonError(405, "method not allowed");
}

/* ============================================================
 * GET /workorders/api/parts?search=&equipment=
 * ============================================================ */

async function handleListParts(request: Request, env: SupabaseEnv): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const equipment = url.searchParams.get("equipment") ?? "";

  const sb = createServiceClient(env);
  // Two round trips on purpose: the equipment list must be computed over the
  // whole table so the filter dropdown stays stable while the list below it
  // narrows. Deriving it from `parts` would make the dropdown delete its own
  // options as soon as a search matched a single equipment group.
  const [parts, equipmentList] = await Promise.all([
    listParts(sb, { search, equipment }),
    listPartsEquipment(sb)
  ]);

  return json({
    ok: true,
    parts,
    equipment: equipmentList
  } satisfies PartsListResponse);
}

/* ============================================================
 * POST /workorders/api/parts — super_admin
 * ============================================================ */

async function handleCreatePart(
  request: Request,
  env: SupabaseEnv,
  session: Session
): Promise<Response> {
  let input: PartsDirectoryInput;
  try {
    const body = await readJsonBody(request);
    input = readPartsInput(body, true);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const sb = createServiceClient(env);
  try {
    const part = await createPart(
      sb,
      input as PartsDirectoryCreateInput,
      session.email ?? ""
    );
    console.log(
      `workorders-worker parts create: id=${part.id} equipment=${part.parent_equipment} by=${session.email}`
    );
    return json({ ok: true, part } satisfies PartResponse, 201);
  } catch (err) {
    if (isPartsDirectoryConflict(err)) return jsonError(409, err.message);
    throw err;
  }
}

/* ============================================================
 * PATCH /workorders/api/parts/{id} — super_admin
 * ============================================================ */

async function handleUpdatePart(
  request: Request,
  env: SupabaseEnv,
  id: string,
  session: Session
): Promise<Response> {
  let input: PartsDirectoryInput;
  try {
    const body = await readJsonBody(request);
    input = readPartsInput(body, false);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const sb = createServiceClient(env);
  try {
    const part = await updatePart(sb, id, input, session.email ?? "");
    if (!part) return jsonError(404, "part not found");
    console.log(`workorders-worker parts update: id=${id} by=${session.email}`);
    return json({ ok: true, part } satisfies PartResponse);
  } catch (err) {
    if (isPartsDirectoryConflict(err)) return jsonError(409, err.message);
    throw err;
  }
}

/* ============================================================
 * DELETE /workorders/api/parts/{id} — super_admin
 * ============================================================ */

async function handleDeletePart(env: SupabaseEnv, id: string): Promise<Response> {
  const sb = createServiceClient(env);
  const result = await deletePart(sb, id);
  if (!result.deleted) return jsonError(404, "part not found");
  console.log(
    `workorders-worker parts delete: id=${id} photo_r2_key=${result.photo_r2_key ?? "(none)"}`
  );
  // The R2 object is now orphaned. apps/web holds the PARTS_FILES binding, so
  // the key travels back with the response and the caller decides.
  return json({
    ok: true,
    photo_r2_key: result.photo_r2_key
  } satisfies PartDeleteResponse);
}
