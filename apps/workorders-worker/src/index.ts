// Splash Work Orders Worker — Brief 70 + Brief 71.
//
// Read-only MaintainX integration. apps/web's /workorders page SSR-fetches
// GET /workorders/api/list via the WORKORDERS_WORKER service binding; the
// response is server-bucketed Reactive vs Preventive (by MaintainX
// `wo.type`) and grouped by MaintainX location, with per-group sort by
// priority HIGH → MEDIUM → LOW → NONE then `updatedAt` desc.
//
// PERMISSION DOMAIN — pure email-on-locations (Brief 71):
//   Each user sees the locations whose `am_email`, `rm_email`, or
//   `site_email` (`locations` table) equals their session email.
//   super_admin / admin do NOT have a global override; if they want
//   global visibility they need their email on the relevant rows.
//   No dc_role check, no global path, no "unmatched" bucket.
//
// FAIL-SOFT POSTURE:
//   - MAINTAINX_API_KEY unbound → 503 with friendly body
//   - MaintainX upstream non-2xx → 502
//   - Network / abort → 504
//   - Anything else → 500
//
// SCHEDULED HANDLER (Brief 71):
//   The default export is { fetch, scheduled }. The scheduled handler
//   runs the daily MaintainX user/team sync (`[triggers] crons` in
//   wrangler.toml — 11:30 UTC). Same pattern as damage-worker post-
//   Brief 65; Workers Logs `[observability.logs]` block from Brief 63
//   covers scheduled invocations automatically (eventType: scheduled).

import { authenticate, type Session } from "@splash/auth";
import {
  getLocationsByContactEmail,
  getMaintainXTeamsByIds,
  getMaintainXUsersByIds,
  type MaintainXTeamRow,
  type MaintainXUserRow,
  type SupabaseEnv,
  type UserAccessibleLocation
} from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";
import {
  fetchMaintainXWorkOrders,
  type RawWorkOrder
} from "./maintainx.js";
import { runMaintainXUserTeamSync, type SyncResult } from "./sync.js";

interface Env extends SupabaseEnv {
  /** MaintainX bearer token. Same value as on splash-damage (Brief 42).
   *  Optional: when unbound the worker returns 503. */
  MAINTAINX_API_KEY?: string;
  /** REST root, no trailing /workorders. `[vars]` entry. */
  MAINTAINX_BASE_URL: string;
  /** Populated for parity with damage-worker; not consumed in v1. */
  APPS_WEB_BASE_URL: string;
}

// Brief 72: pagination limits.
//   - Single-location users: skip pagination; MaintainX's 200-per-call
//     cap is enough headroom for any one site's open queue.
//   - Multi-location users: paginate up to MAX_WORK_ORDERS_MULTI total.
//     Past the cap, the page renders a truncation banner.
const MAX_WORK_ORDERS_SINGLE = 200;
const MAX_WORK_ORDERS_MULTI = 1000;
const TIMEOUT_SINGLE_MS = 8_000;
const TIMEOUT_MULTI_MS = 30_000;

/** Hardcoded super-admin allow-list for the on-demand sync trigger. Mirrors
 *  the operator/super_admin list called out in CLAUDE.md "operator
 *  preferences"; defense-in-depth backed by `session.dcRole === "super_admin"`
 *  fallback in `isSyncTriggerAllowed`. */
const SYNC_ADMIN_EMAILS = new Set<string>([
  "joshua.copp@gmail.com",
  "josh.copp@splashcarwashes.com",
  "noah@splashcarwashes.com",
  "alexandro@splashcarwashes.com",
  "jacob@splashcarwashes.com",
  "rwilliams@splashcarwashes.com"
]);

/* ============================================================
 * Response shape — server already bucketed + grouped + decorated.
 * ============================================================ */

interface AssigneeOut {
  id: number | null;
  type: "USER" | "TEAM" | "OTHER";
  name: string;
  email: string | null;
}

interface WorkOrderOut {
  id: number;
  sequentialId: number | null;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "NONE" | string;
  type: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dueDate: string | null;
  description: string | null;
  assignees: AssigneeOut[];
  categories: string[];
  locationId: number | null;
}

interface GroupOut {
  /** MaintainX location ID — group key. */
  maintainx_id: number;
  /** Header label. Prefers MaintainX's own `expand=location.name`; falls
   *  back to the Splash-side postal address from `locations.location`,
   *  then to a "(unknown location)" placeholder. */
  location_pretty: string;
  work_orders: WorkOrderOut[];
}

interface ListResponse {
  reactive: { groups: GroupOut[] };
  preventive: { groups: GroupOut[] };
  fetchedAt: string;
  truncated: boolean;
  /** Brief 72: number of MaintainX API calls made (1 for single-location
   *  users, 1-5 for multi-location users on the paginated path). */
  pageCount: number;
  accessibleLocationCount: number;
  mappedLocationCount: number;
  email: string;
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

      if (path === "workorders/api/sync-maintainx-users" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        if (!isSyncTriggerAllowed(auth.session)) {
          return jsonError(403, "manual sync requires super_admin");
        }
        const result = await runMaintainXUserTeamSync(env);
        console.log("workorders-worker manual sync complete:", JSON.stringify(result));
        return json(result satisfies SyncResult);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("workorders-worker request failed:", path, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runMaintainXUserTeamSync(env);
          console.log("workorders-worker scheduled sync complete:", JSON.stringify(result));
        } catch (err) {
          console.error("workorders-worker scheduled sync failed:", err);
        }
      })()
    );
  }
} satisfies ExportedHandler<Env>;

function isSyncTriggerAllowed(session: Session): boolean {
  const email = session.email?.trim().toLowerCase() ?? "";
  if (email && SYNC_ADMIN_EMAILS.has(email)) return true;
  return session.dcRole === "super_admin";
}

/* ============================================================
 * GET /workorders/api/list — pure email-on-locations gate.
 * ============================================================ */

async function handleList(env: Env, session: Session): Promise<Response> {
  const email = session.email?.trim().toLowerCase() ?? "";
  if (!email) return jsonError(401, "no session email");

  if (!env.MAINTAINX_API_KEY) {
    return jsonError(503, "MaintainX integration not configured");
  }

  // Phase 1 — resolve user's accessible locations via email match.
  const accessible = await getLocationsByContactEmail(env, email);
  const mappedMxIds = accessible
    .map((l) => l.maintainx_id)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

  const fetchedAt = new Date().toISOString();
  if (mappedMxIds.length === 0) {
    return json({
      reactive: { groups: [] },
      preventive: { groups: [] },
      fetchedAt,
      truncated: false,
      pageCount: 0,
      accessibleLocationCount: accessible.length,
      mappedLocationCount: 0,
      email
    } satisfies ListResponse);
  }

  // Phase 2 — fetch MaintainX work orders for those location IDs.
  // Brief 72: multi-location users paginate the cursor; single-location
  // users keep the original single-call posture.
  const shouldPaginate = mappedMxIds.length > 1;
  const timeoutMs = shouldPaginate ? TIMEOUT_MULTI_MS : TIMEOUT_SINGLE_MS;
  const maxWorkOrders = shouldPaginate ? MAX_WORK_ORDERS_MULTI : MAX_WORK_ORDERS_SINGLE;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let result;
  try {
    result = await fetchMaintainXWorkOrders({
      apiKey: env.MAINTAINX_API_KEY,
      baseUrl: env.MAINTAINX_BASE_URL,
      maintainxLocationIds: mappedMxIds,
      paginate: shouldPaginate,
      maxWorkOrders,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!result.ok) {
    if (result.status === 0) return jsonError(504, "MaintainX timeout");
    return jsonError(502, `MaintainX upstream returned ${result.status}`);
  }

  // Phase 3 — resolve assignee + team names from the Supabase cache.
  const userIds = collectAssigneeIdsByType(result.workOrders, "USER");
  const teamIds = collectAssigneeIdsByType(result.workOrders, "TEAM");
  const [users, teams] = await Promise.all([
    userIds.length ? getMaintainXUsersByIds(env, userIds) : Promise.resolve(new Map<number, MaintainXUserRow>()),
    teamIds.length ? getMaintainXTeamsByIds(env, teamIds) : Promise.resolve(new Map<number, MaintainXTeamRow>())
  ]);

  // Phase 4 — bucket Reactive vs Preventive, then group each bucket.
  const buckets = bucketByType(result.workOrders);
  const accessibleByMxId = new Map<number, UserAccessibleLocation>();
  for (const loc of accessible) {
    if (loc.maintainx_id != null) accessibleByMxId.set(loc.maintainx_id, loc);
  }
  const reactive = groupByLocation(buckets.reactive, users, teams, accessibleByMxId);
  const preventive = groupByLocation(buckets.preventive, users, teams, accessibleByMxId);

  console.log(
    `workorders-worker list: email=${email} mappedMxIds=${mappedMxIds.length} paginate=${shouldPaginate} pageCount=${result.pageCount} workOrders=${result.workOrders.length} truncated=${result.truncated}`
  );

  return json({
    reactive: { groups: reactive },
    preventive: { groups: preventive },
    fetchedAt,
    truncated: result.truncated,
    pageCount: result.pageCount,
    accessibleLocationCount: accessible.length,
    mappedLocationCount: mappedMxIds.length,
    email
  } satisfies ListResponse);
}

/* ============================================================
 * Bucketing + grouping helpers
 * ============================================================ */

/**
 * Canonical filter is `wo.type === "PREVENTIVE"`. Everything else
 * (REACTIVE, CYCLE_COUNT, null, unknowns) lands in the Reactive bucket
 * — operators day-to-day work the reactive queue. If MaintainX adds new
 * preventive-flavored types (e.g. "PREVENTIVE_DAILY"), widen this rule
 * to `type?.startsWith("PREVENT")` after operator confirmation.
 */
function bucketByType(workOrders: RawWorkOrder[]): {
  reactive: RawWorkOrder[];
  preventive: RawWorkOrder[];
} {
  const reactive: RawWorkOrder[] = [];
  const preventive: RawWorkOrder[] = [];
  for (const wo of workOrders) {
    if (typeof wo.type === "string" && wo.type === "PREVENTIVE") {
      preventive.push(wo);
    } else {
      reactive.push(wo);
    }
  }
  return { reactive, preventive };
}

function collectAssigneeIdsByType(workOrders: RawWorkOrder[], type: "USER" | "TEAM"): number[] {
  const out = new Set<number>();
  for (const wo of workOrders) {
    if (!Array.isArray(wo.assignees)) continue;
    for (const a of wo.assignees) {
      if (!a || typeof a !== "object") continue;
      const t = typeof a.type === "string" ? a.type : null;
      if (t !== type) continue;
      const id = typeof a.id === "number" && Number.isFinite(a.id) ? a.id : null;
      if (id != null) out.add(id);
    }
  }
  return [...out];
}

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
  const ua = a.updatedAt ?? "";
  const ub = b.updatedAt ?? "";
  if (ua === ub) return 0;
  return ua < ub ? 1 : -1;
}

function compareGroups(a: GroupOut, b: GroupOut): number {
  return a.location_pretty.localeCompare(b.location_pretty);
}

function groupByLocation(
  workOrders: RawWorkOrder[],
  users: Map<number, MaintainXUserRow>,
  teams: Map<number, MaintainXTeamRow>,
  accessibleByMxId: Map<number, UserAccessibleLocation>
): GroupOut[] {
  const buckets = new Map<number, { header: string; items: WorkOrderOut[] }>();
  for (const wo of workOrders) {
    const projected = projectWorkOrder(wo, users, teams);
    if (!projected) continue;
    const mxId = projected.locationId;
    if (mxId == null) continue;

    let bucket = buckets.get(mxId);
    if (!bucket) {
      const headerFromMx = extractRawLocationName(wo);
      const fallbackAddress = accessibleByMxId.get(mxId)?.location_address ?? null;
      bucket = {
        header: headerFromMx ?? fallbackAddress ?? "(unknown location)",
        items: []
      };
      buckets.set(mxId, bucket);
    } else if (
      bucket.header === "(unknown location)" ||
      bucket.header === (accessibleByMxId.get(mxId)?.location_address ?? "")
    ) {
      // Upgrade the header if a later WO in this bucket carries the
      // MaintainX-side name (Brief 71 prefers MX's name when available).
      const headerFromMx = extractRawLocationName(wo);
      if (headerFromMx) bucket.header = headerFromMx;
    }
    bucket.items.push(projected);
  }

  const groups: GroupOut[] = [];
  for (const [mxId, b] of buckets.entries()) {
    b.items.sort(compareWorkOrders);
    groups.push({
      maintainx_id: mxId,
      location_pretty: b.header,
      work_orders: b.items
    });
  }
  groups.sort(compareGroups);
  return groups;
}

/* ============================================================
 * Projection — RawWorkOrder → WorkOrderOut with name decoration.
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

function projectAssignees(
  raw: RawWorkOrder["assignees"],
  users: Map<number, MaintainXUserRow>,
  teams: Map<number, MaintainXTeamRow>
): AssigneeOut[] {
  if (!Array.isArray(raw)) return [];
  const out: AssigneeOut[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const id = typeof a.id === "number" && Number.isFinite(a.id) ? a.id : null;
    const rawType = typeof a.type === "string" ? a.type : null;
    let type: AssigneeOut["type"] = "OTHER";
    let name = "";
    let email: string | null = null;
    if (rawType === "USER") {
      type = "USER";
      const cached = id != null ? users.get(id) : undefined;
      name = cached?.full_name?.trim() || (id != null ? `User #${id}` : "Unknown user");
      email = cached?.email ?? null;
    } else if (rawType === "TEAM") {
      type = "TEAM";
      const cached = id != null ? teams.get(id) : undefined;
      name = cached?.name?.trim() || (id != null ? `Team #${id}` : "Unknown team");
    } else {
      name = id != null ? `Assignee #${id}` : "Unknown";
    }
    out.push({ id, type, name, email });
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

function projectWorkOrder(
  wo: RawWorkOrder,
  users: Map<number, MaintainXUserRow>,
  teams: Map<number, MaintainXTeamRow>
): WorkOrderOut | null {
  if (typeof wo.id !== "number" || !Number.isFinite(wo.id)) return null;
  return {
    id: wo.id,
    sequentialId: typeof wo.sequentialId === "number" ? wo.sequentialId : null,
    title: typeof wo.title === "string" ? wo.title : "",
    status: typeof wo.status === "string" ? wo.status : "",
    priority: typeof wo.priority === "string" ? wo.priority : "NONE",
    type: typeof wo.type === "string" ? wo.type : null,
    createdAt: typeof wo.createdAt === "string" ? wo.createdAt : null,
    updatedAt: typeof wo.updatedAt === "string" ? wo.updatedAt : null,
    dueDate: typeof wo.dueDate === "string" ? wo.dueDate : null,
    description: typeof wo.description === "string" && wo.description.trim()
      ? wo.description.trim()
      : null,
    assignees: projectAssignees(wo.assignees, users, teams),
    categories: projectCategories(wo.categories),
    locationId: extractRawLocationId(wo)
  };
}
