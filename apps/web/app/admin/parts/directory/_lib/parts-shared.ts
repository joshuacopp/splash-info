// Parts Directory — the pieces both the server helper and the browser need.
//
// Split out of ./parts.ts because that module imports `next/headers`, which
// makes it server-only. PartsDirectory and PartEditor are client components
// and only want the row type and the photo-URL builder; importing those from
// parts.ts dragged `next/headers` into the client bundle and failed the build
// with "You're importing a component that needs next/headers".
//
// Nothing in this file may import next/headers, next/server, or the
// Cloudflare context. Keep it pure — types and functions that run anywhere.

/**
 * One row of the directory. Mirrors the worker's `GET /workorders/api/parts`
 * response exactly. Everything except the identity/audit columns is nullable
 * — a part can be logged with nothing but a name and the machine it came off,
 * and filled in later.
 */
export interface PartRow {
  id: string;
  /**
   * Every machine this part is used on. A bearing or a cylinder is routinely
   * shared across the wrap, the top brush and the conveyor, so this is an
   * ARRAY, not a single machine — a part used on three machines is one row
   * that lists three names, not three rows.
   *
   * MAY BE EMPTY. An operator is allowed to log a part before knowing where
   * it fits, so nothing downstream may assume `[0]` exists. The directory
   * groups those rows under an "Unassigned" heading rather than dropping them.
   */
  parent_equipment: string[];
  part_name: string;
  part_number: string | null;
  vendor: string | null;
  /** `parts-directory/{id}/{nanoid}.jpg` — see partPhotoUrl(). */
  photo_r2_key: string | null;
  unit_cost: number | null;
  vendor_url: string | null;
  /** Sites that use this part. Display metadata, NOT an access scope. */
  location_codes: string[];
  notes: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/**
 * Coerce whatever the wire actually produced into a clean `string[]`.
 *
 * The worker now always sends an array, but this row shape crosses a service
 * binding and survived a column migration from `text` to `text[]`, so a stray
 * scalar (an un-migrated cache, an older worker still deployed on a preview)
 * would otherwise render as `undefined.map` and take the whole shelf down.
 * Tolerating it costs one function; trusting the wire costs a white page.
 *
 * Blank strings are dropped so `[""]` can't become a nameless group heading.
 */
export function toEquipmentList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export type PartsFetchResult =
  | { kind: "ok"; parts: PartRow[]; equipment: string[] }
  | { kind: "unavailable" }
  | { kind: "denied" }
  | { kind: "error"; status: number };

export interface FetchPartsParams {
  /** Server-side search. The page passes nothing — filtering is client-side
   *  over the full list, which is what makes it instant. Here for the admin
   *  pass and for any future paginated surface. */
  search?: string;
  /** Server-side parent_equipment filter. Same note as `search`. */
  equipment?: string;
}

/**
 * The worker's parts surface. Exported because the admin write proxies
 * (../api/parts/route.ts and ../api/parts/[id]/route.ts) build item paths off
 * it as `${PARTS_API_PATH}/${id}`.
 */
export const PARTS_API_PATH = "/workorders/api/parts";

/**
 * Browser-facing URL for a part photo. The serve route
 * (`/admin/parts/directory/photo/[...key]`) is built in the next pass; this
 * only produces the href, so the <img src> is stable ahead of it.
 *
 * Keys carry slashes (`parts-directory/{id}/{nanoid}.jpg`) and those are real
 * path separators, so each segment is encoded individually rather than
 * running the whole key through encodeURIComponent (which would turn the
 * separators into %2F and break the route match).
 */
export function partPhotoUrl(r2Key: string): string {
  const encoded = r2Key
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/admin/parts/directory/photo/${encoded}`;
}
