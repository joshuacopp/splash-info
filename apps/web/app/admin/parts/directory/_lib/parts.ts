// Parts Directory (/admin/parts/directory) — server-side read helper.
//
// The directory itself lives in Supabase behind the workorders-worker; this
// file is only the transport. Same dual-mode shape as every other worker
// helper in apps/web (see ../../../promotions/_lib/worker-fetch.ts and
// ../../../../workorders/_lib/worker-fetch.ts):
//
//   PRODUCTION / STAGING (Workers runtime):
//     env.WORKORDERS_WORKER — the service binding already declared in
//     apps/web/wrangler.toml. Cloudflare routes the subrequest internally,
//     which is what keeps a same-zone Worker-to-Worker call from looping
//     back out through the edge and 522-ing. Service bindings ignore the
//     URL host, so the request is built against `https://internal` to keep
//     logs predictable.
//
//   DEV (`next dev`, outside the Workers runtime):
//     getCloudflareContext() throws or the binding is undefined, and we fall
//     through to a URL fetch. NEXT_PUBLIC_WORKORDERS_WORKER_URL when set,
//     otherwise the request host (next.config.mjs rewrites /workorders/api/*).
//
// FAIL-SOFT POSTURE. This page is a reference shelf, not a system of record:
// a tech who can't reach it should be told why, not shown a stack trace. So
// nothing here throws. Every failure collapses into a `PartsFetchResult`
// variant the page renders as a card — mirroring how ../../_lib/manuals.ts
// models a missing R2 binding with `PartsBindingUnavailable`:
//
//   "unavailable" — no binding and no reachable worker (plain `next dev`),
//                   or the endpoint isn't deployed yet (404).
//   "denied"      — 401/403. The session isn't valid for the worker.
//   "error"       — anything else non-2xx, status carried for the banner.
//
// The auth posture matches the Parts manuals index: any authenticated
// session. Middleware gates /admin/*, the worker re-checks, and nothing in
// the directory is per-location or per-role — `location_codes` on a row is
// "which sites use this part", not an access scope.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * One row of the directory. Mirrors the worker's `GET /workorders/api/parts`
 * response exactly. Everything except the identity/audit columns is nullable
 * — a part can be logged with nothing but a name and the machine it came off,
 * and filled in later.
 */
export interface PartRow {
  id: string;
  /** The machine this part belongs to. Also the grouping key in the UI. */
  parent_equipment: string;
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

/** Raw worker response body for the list endpoint. */
interface PartsListResponse {
  ok: true;
  parts: PartRow[];
  /** Distinct sorted parent_equipment across ALL rows, not just this page. */
  equipment: string[];
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
 * Absolute URL for the dev fallback. Server-only: CF Workers' fetch refuses
 * relative URLs server-side, which is why this is always absolute.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

export interface PartsWorkerRequestInit {
  method: string;
  /**
   * Already-serialized JSON. When present the subrequest carries
   * `Content-Type: application/json`, which the worker REQUIRES on writes —
   * that header IS its CSRF barrier (a cross-site fetch cannot set it without
   * a preflight the worker never answers). See the CSRF note at the top of
   * apps/workorders-worker/src/parts.ts before removing it.
   */
  jsonBody?: string;
}

/**
 * The single transport for every parts call, read or write: the service
 * binding when we are inside the Workers runtime, a URL fetch otherwise. The
 * caller's cookie is always forwarded — the worker re-authenticates and
 * re-checks the super_admin gate on its own side.
 *
 * Returns null (rather than throwing) when neither transport is available, so
 * read callers can report "unavailable" and the write proxies can answer 503
 * instead of a 500.
 */
export async function partsWorkerFetch(
  path: string,
  init: PartsWorkerRequestInit = { method: "GET" }
): Promise<Response | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const trimmed = path.startsWith("/") ? path : `/${path}`;

  const headers: Record<string, string> = { Cookie: cookieHeader };
  if (init.jsonBody !== undefined) headers["Content-Type"] = "application/json";

  let binding: CloudflareEnv["WORKORDERS_WORKER"] | undefined;
  try {
    const { env } = await getCloudflareContext({ async: true });
    binding = env?.WORKORDERS_WORKER;
  } catch {
    // No Cloudflare context (plain `next dev`) — try the URL path below.
  }

  if (binding) {
    try {
      return await binding.fetch(
        new Request(`https://internal${trimmed}`, {
          method: init.method,
          headers,
          body: init.jsonBody
        })
      );
    } catch (err) {
      // The binding exists but the subrequest threw. A GET may safely retry
      // over the URL fallback below; a write may NOT — in production that URL
      // resolves to the same worker through the edge, so a retry could apply
      // the write twice. Fail closed for anything non-GET.
      if (init.method.toUpperCase() !== "GET") {
        console.error("[parts] worker subrequest failed", err);
        return null;
      }
    }
  }

  try {
    const url = await workerUrl(path);
    return await fetch(url, {
      method: init.method,
      headers,
      body: init.jsonBody,
      cache: "no-store"
    });
  } catch {
    // Nothing listening on the fallback host either.
    return null;
  }
}

function buildQuery(params: FetchPartsParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.equipment) sp.set("equipment", params.equipment);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * The whole directory, in one call. Never throws — see the fail-soft note at
 * the top of the file. A 404 is folded into "unavailable" on purpose: until
 * the worker route ships, that is indistinguishable from "the backend isn't
 * here", and both want the same explanatory card.
 */
export async function fetchParts(
  params: FetchPartsParams = {}
): Promise<PartsFetchResult> {
  const resp = await partsWorkerFetch(`${PARTS_API_PATH}${buildQuery(params)}`);
  if (!resp) return { kind: "unavailable" };
  if (resp.status === 401 || resp.status === 403) return { kind: "denied" };
  if (resp.status === 404) return { kind: "unavailable" };
  if (!resp.ok) return { kind: "error", status: resp.status };

  let body: PartsListResponse | null = null;
  try {
    body = (await resp.json()) as PartsListResponse;
  } catch {
    // 200 with an unparseable body means something is in front of the worker
    // (an HTML login page, a CF error interstitial). Treat it as unreachable.
    return { kind: "unavailable" };
  }

  // Defensive: a malformed payload should degrade to an empty shelf, not
  // crash the render with `undefined.map`.
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  const equipment = Array.isArray(body?.equipment)
    ? body.equipment
    : // Derive the filter list from the rows when the worker omits it.
      [...new Set(parts.map((p) => p.parent_equipment).filter(Boolean))].sort(
        (a, z) => a.localeCompare(z)
      );

  return { kind: "ok", parts, equipment };
}

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
