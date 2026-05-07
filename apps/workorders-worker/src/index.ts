// Splash Work Orders Worker — Brief 70.
//
// Read-only MaintainX integration. apps/web's /workorders page SSR-
// fetches GET /workorders/api/list via the WORKORDERS_WORKER service
// binding; the response is server-grouped by Splash location_code with
// per-group sort by priority (HIGH/MEDIUM/LOW/NONE), tie-breaker
// updatedAt desc.
//
// PERMISSION DOMAIN — dc_role (Brief 61):
//   super_admin / admin       → global (no location filter sent to MX)
//   gm / rm                   → scoped to dc_locations
//   no dc_role                → 403 (page renders an inline gated message)
//
// FAIL-SOFT POSTURE:
//   - MAINTAINX_API_KEY unbound → 503 with friendly body
//   - MaintainX upstream non-2xx → 502
//   - Network / abort → 504
//   - Anything else → 500

import { authenticate, type Session } from "@splash/auth";
import {
  getLocationCodesByMaintainXIds,
  getMaintainXIdsForLocationCodes,
  type MaintainXLocationInfo,
  type SupabaseEnv
} from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";
import {
  fetchMaintainXWorkOrders,
  type RawWorkOrder
} from "./maintainx.js";

interface Env extends SupabaseEnv {
  /** MaintainX bearer token. Same value as on splash-damage (Brief 42).
   *  Optional: when unbound the worker returns 503. */
  MAINTAINX_API_KEY?: string;
  /** REST root, no trailing /workorders. `[vars]` entry. */
  MAINTAINX_BASE_URL: string;
  /** Populated for parity with damage-worker; not consumed in v1. */
  APPS_WEB_BASE_URL: string;
}

/** Hard cap on the description text echoed back in the list response.
 *  MaintainX descriptions can be 1-2 KB; the page is for scanning, not
 *  reading — operators click out to MaintainX for the full text. */
const DESCRIPTION_MAX_CHARS = 500;

/** AbortController timeout for the upstream MaintainX call. Mirrors
 *  damage-worker's WO-create timeout (Brief 42). */
const MAINTAINX_TIMEOUT_MS = 8000;

/* ============================================================
 * dc_role scope helper — duplicated from damage-worker by design.
 * Brief 70 explicitly chose duplication over shared package: the
 * helper is six lines, the two workers are domain-isolated, and
 * extracting to a package would couple them on a stable API
 * surface for marginal gain. If a third domain reuses this shape
 * we can lift it then.
 * ============================================================ */

type WorkOrderScope =
  | { kind: "global" }
  | { kind: "scoped"; codes: string[] }
  | { kind: "denied" };

function workOrderScopeForSession(session: Session): WorkOrderScope {
  if (session.dcRole === null) return { kind: "denied" };
  if (session.dcRole === "super_admin" || session.dcRole === "admin") {
    return { kind: "global" };
  }
  return { kind: "scoped", codes: session.dcLocations };
}

/* ============================================================
 * Response shape — server already sorted + grouped.
 * ============================================================ */

interface AssigneeOut {
  id: number | null;
  name: string;
}

interface WorkOrderOut {
  id: number;
  sequentialId: number | null;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "NONE" | string;
  createdAt: string | null;
  updatedAt: string | null;
  dueDate: string | null;
  description: string | null;
  assignees: AssigneeOut[];
  thumbnailUrl: string | null;
  categories: string[];
}

interface GroupOut {
  location_code: string;
  location_pretty: string | null;
  maintainx_id: number;
  work_orders: WorkOrderOut[];
}

interface UnmatchedWorkOrderOut extends WorkOrderOut {
  maintainxLocationId: number | null;
  maintainxLocationName: string | null;
}

interface ListResponse {
  scope: "global" | "scoped";
  missingMaintainxIds: string[];
  groups: GroupOut[];
  unmatchedWorkOrders: UnmatchedWorkOrderOut[];
  truncated: boolean;
  fetchedAt: string;
}

/* ============================================================
 * Top-level fetch
 * ============================================================ */

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");

    try {
      if (path === "workorders/api/list" && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        return handleList(env, auth.session);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("workorders-worker request failed:", path, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  }
} satisfies ExportedHandler<Env>;

/* ============================================================
 * GET /workorders/api/list
 * ============================================================ */

async function handleList(env: Env, session: Session): Promise<Response> {
  const scope = workOrderScopeForSession(session);
  if (scope.kind === "denied") return jsonError(403, "no damage role assigned");

  if (!env.MAINTAINX_API_KEY) {
    return jsonError(503, "MaintainX integration not configured");
  }

  // For scoped users, resolve dc_locations → maintainx_ids. Drop unmapped.
  let scopedLocationInfo: MaintainXLocationInfo[] = [];
  let maintainxIdFilter: number[] | undefined;
  let missingMaintainxIds: string[] = [];

  if (scope.kind === "scoped") {
    if (scope.codes.length === 0) {
      // gm/rm with no assigned locations → empty result, not 403.
      return json({
        scope: "scoped",
        missingMaintainxIds: [],
        groups: [],
        unmatchedWorkOrders: [],
        truncated: false,
        fetchedAt: new Date().toISOString()
      } satisfies ListResponse);
    }
    scopedLocationInfo = await getMaintainXIdsForLocationCodes(env, scope.codes);
    maintainxIdFilter = scopedLocationInfo
      .map((info) => info.maintainx_id)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    missingMaintainxIds = scopedLocationInfo
      .filter((info) => info.maintainx_id == null)
      .map((info) => info.location_code);

    if (maintainxIdFilter.length === 0) {
      // Every dc_location lacks a MaintainX mapping. Return empty groups
      // but surface the missing list so the page can warn.
      return json({
        scope: "scoped",
        missingMaintainxIds,
        groups: [],
        unmatchedWorkOrders: [],
        truncated: false,
        fetchedAt: new Date().toISOString()
      } satisfies ListResponse);
    }
  }

  // Fire MaintainX with an 8s timeout.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAINTAINX_TIMEOUT_MS);
  let result;
  try {
    result = await fetchMaintainXWorkOrders({
      apiKey: env.MAINTAINX_API_KEY,
      baseUrl: env.MAINTAINX_BASE_URL,
      maintainxLocationIds: maintainxIdFilter,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!result.ok) {
    if (result.status === 0) {
      // Network failure or AbortError.
      return jsonError(504, "MaintainX timeout");
    }
    return jsonError(502, `MaintainX upstream returned ${result.status}`);
  }

  // Build the group structure.
  const fetchedAt = new Date().toISOString();
  if (scope.kind === "scoped") {
    const groups = groupForScoped(result.workOrders, scopedLocationInfo);
    return json({
      scope: "scoped",
      missingMaintainxIds,
      groups,
      unmatchedWorkOrders: [],
      truncated: result.truncated,
      fetchedAt
    } satisfies ListResponse);
  }

  // Global: resolve every distinct locationId from the response back to a
  // location_code via the reverse lookup helper.
  const distinctMxIds = [
    ...new Set(
      result.workOrders
        .map((wo) => extractRawLocationId(wo))
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    )
  ];
  const reverseMap = await getLocationCodesByMaintainXIds(env, distinctMxIds);
  const { groups, unmatched } = groupForGlobal(result.workOrders, reverseMap);
  return json({
    scope: "global",
    missingMaintainxIds: [],
    groups,
    unmatchedWorkOrders: unmatched,
    truncated: result.truncated,
    fetchedAt
  } satisfies ListResponse);
}

/* ============================================================
 * Grouping + sort
 * ============================================================ */

const PRIORITY_NONE_RANK = 3;
const PRIORITY_ORDER: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  NONE: PRIORITY_NONE_RANK
};

function priorityRank(p: string | null | undefined): number {
  if (typeof p !== "string") return PRIORITY_NONE_RANK;
  return PRIORITY_ORDER[p] ?? PRIORITY_NONE_RANK;
}

function compareWorkOrders(a: WorkOrderOut, b: WorkOrderOut): number {
  const pa = priorityRank(a.priority);
  const pb = priorityRank(b.priority);
  if (pa !== pb) return pa - pb;
  // updatedAt desc (newer first)
  const ua = a.updatedAt ?? "";
  const ub = b.updatedAt ?? "";
  if (ua === ub) return 0;
  return ua < ub ? 1 : -1;
}

function compareGroups(a: GroupOut, b: GroupOut): number {
  const ap = a.location_pretty ?? a.location_code;
  const bp = b.location_pretty ?? b.location_code;
  return ap.localeCompare(bp);
}

function groupForScoped(
  raw: RawWorkOrder[],
  scopedInfo: MaintainXLocationInfo[]
): GroupOut[] {
  const byMaintainxId = new Map<number, MaintainXLocationInfo>();
  for (const info of scopedInfo) {
    if (info.maintainx_id != null) {
      byMaintainxId.set(info.maintainx_id, info);
    }
  }

  const buckets = new Map<number, WorkOrderOut[]>();
  for (const wo of raw) {
    const mxId = extractRawLocationId(wo);
    if (mxId == null) continue;
    if (!byMaintainxId.has(mxId)) continue; // defense-in-depth filter
    const projected = projectWorkOrder(wo);
    if (!projected) continue;
    let bucket = buckets.get(mxId);
    if (!bucket) {
      bucket = [];
      buckets.set(mxId, bucket);
    }
    bucket.push(projected);
  }

  const groups: GroupOut[] = [];
  for (const [mxId, items] of buckets.entries()) {
    const info = byMaintainxId.get(mxId);
    if (!info) continue;
    items.sort(compareWorkOrders);
    groups.push({
      location_code: info.location_code,
      location_pretty: info.location_pretty,
      maintainx_id: mxId,
      work_orders: items
    });
  }
  groups.sort(compareGroups);
  return groups;
}

function groupForGlobal(
  raw: RawWorkOrder[],
  reverse: Map<number, MaintainXLocationInfo>
): { groups: GroupOut[]; unmatched: UnmatchedWorkOrderOut[] } {
  const buckets = new Map<number, WorkOrderOut[]>();
  const unmatched: UnmatchedWorkOrderOut[] = [];

  for (const wo of raw) {
    const projected = projectWorkOrder(wo);
    if (!projected) continue;
    const mxId = extractRawLocationId(wo);
    const info = mxId != null ? reverse.get(mxId) : undefined;
    if (info && mxId != null) {
      let bucket = buckets.get(mxId);
      if (!bucket) {
        bucket = [];
        buckets.set(mxId, bucket);
      }
      bucket.push(projected);
    } else {
      unmatched.push({
        ...projected,
        maintainxLocationId: mxId ?? null,
        maintainxLocationName: extractRawLocationName(wo)
      });
    }
  }

  const groups: GroupOut[] = [];
  for (const [mxId, items] of buckets.entries()) {
    const info = reverse.get(mxId);
    if (!info) continue;
    items.sort(compareWorkOrders);
    groups.push({
      location_code: info.location_code,
      location_pretty: info.location_pretty,
      maintainx_id: mxId,
      work_orders: items
    });
  }
  groups.sort(compareGroups);
  unmatched.sort(compareWorkOrders);
  return { groups, unmatched };
}

/* ============================================================
 * Projection — RawWorkOrder → WorkOrderOut
 * ============================================================ */

function extractRawLocationId(wo: RawWorkOrder): number | null {
  if (typeof wo.locationId === "number" && Number.isFinite(wo.locationId)) {
    return wo.locationId;
  }
  if (wo.location && typeof wo.location.id === "number" && Number.isFinite(wo.location.id)) {
    return wo.location.id;
  }
  return null;
}

function extractRawLocationName(wo: RawWorkOrder): string | null {
  if (wo.location && typeof wo.location.name === "string" && wo.location.name) {
    return wo.location.name;
  }
  return null;
}

function projectAssignees(raw: RawWorkOrder["assignees"]): AssigneeOut[] {
  if (!Array.isArray(raw)) return [];
  const out: AssigneeOut[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const id = typeof a.id === "number" && Number.isFinite(a.id) ? a.id : null;
    let name = typeof a.fullName === "string" ? a.fullName : "";
    if (!name) {
      const first = typeof a.firstName === "string" ? a.firstName : "";
      const last = typeof a.lastName === "string" ? a.lastName : "";
      name = `${first} ${last}`.trim();
    }
    if (!name) name = id != null ? `User #${id}` : "Unknown";
    out.push({ id, name });
  }
  return out;
}

function projectCategories(raw: RawWorkOrder["categories"]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c === "string") {
      if (c) out.push(c);
    } else if (c && typeof c === "object" && typeof c.name === "string" && c.name) {
      out.push(c.name);
    }
  }
  return out;
}

function projectThumbnail(wo: RawWorkOrder): string | null {
  if (typeof wo.thumbnailUrl === "string" && wo.thumbnailUrl) return wo.thumbnailUrl;
  if (wo.thumbnail && typeof wo.thumbnail.url === "string" && wo.thumbnail.url) {
    return wo.thumbnail.url;
  }
  return null;
}

function truncateDescription(desc: string | null | undefined): string | null {
  if (typeof desc !== "string") return null;
  const trimmed = desc.trim();
  if (!trimmed) return null;
  if (trimmed.length <= DESCRIPTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, DESCRIPTION_MAX_CHARS)}…`;
}

function projectWorkOrder(wo: RawWorkOrder): WorkOrderOut | null {
  if (typeof wo.id !== "number" || !Number.isFinite(wo.id)) return null;
  return {
    id: wo.id,
    sequentialId: typeof wo.sequentialId === "number" ? wo.sequentialId : null,
    title: typeof wo.title === "string" ? wo.title : "",
    status: typeof wo.status === "string" ? wo.status : "",
    priority: typeof wo.priority === "string" ? wo.priority : "NONE",
    createdAt: typeof wo.createdAt === "string" ? wo.createdAt : null,
    updatedAt: typeof wo.updatedAt === "string" ? wo.updatedAt : null,
    dueDate: typeof wo.dueDate === "string" ? wo.dueDate : null,
    description: truncateDescription(wo.description ?? null),
    assignees: projectAssignees(wo.assignees),
    thumbnailUrl: projectThumbnail(wo),
    categories: projectCategories(wo.categories)
  };
}
