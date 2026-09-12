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
import {
  PARTS_API_PATH,
  partPhotoUrl,
  toEquipmentList,
  type FetchPartsParams,
  type PartRow,
  type PartsFetchResult
} from "./parts-shared";

// Re-exported so server-side callers keep importing everything from one place.
// Client components must import from ./parts-shared directly — pulling any
// runtime value out of THIS module puts next/headers in the browser bundle.
export {
  PARTS_API_PATH,
  partPhotoUrl,
  toEquipmentList,
  type FetchPartsParams,
  type PartRow,
  type PartsFetchResult
};
import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Raw worker response body for the list endpoint. */
interface PartsListResponse {
  ok: true;
  parts: PartRow[];
  /**
   * The flattened, deduped, sorted union of every row's parent_equipment.
   *
   * Note it is computed over ALL rows and does NOT shrink while `?search=` is
   * active. That is deliberate: the facet is the machine registry, and a
   * filter dropdown whose options disappear as you type is unusable.
   */
  equipment: string[];
}

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
  const rawParts = Array.isArray(body?.parts) ? body.parts : [];

  // parent_equipment is the one field the UI iterates unconditionally, so it
  // is normalized on the way in rather than guarded at every call site. A
  // stray scalar becomes `[value]`, a null/undefined becomes `[]`.
  const parts: PartRow[] = rawParts.map((p) => ({
    ...p,
    parent_equipment: toEquipmentList(p?.parent_equipment),
    location_codes: Array.isArray(p?.location_codes) ? p.location_codes : []
  }));

  const equipment = Array.isArray(body?.equipment)
    ? // Normalize the facet too — it feeds <option value> and the group order.
      [...new Set(toEquipmentList(body.equipment))].sort((a, z) =>
        a.localeCompare(z)
      )
    : // Derive it from the rows when the worker omits it. Flattened, because
      // one row can now contribute several machines to the registry.
      [...new Set(parts.flatMap((p) => p.parent_equipment))].sort((a, z) =>
        a.localeCompare(z)
      );

  return { kind: "ok", parts, equipment };
}
