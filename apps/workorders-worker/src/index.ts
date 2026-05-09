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
  getMaintainXUserByEmail,
  getMaintainXUsersByIds,
  type MaintainXTeamRow,
  type MaintainXUserRow,
  type SupabaseEnv,
  type UserAccessibleLocation
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import {
  createMaintainXWorkRequest,
  fetchMaintainXWorkOrders,
  uploadMaintainXWorkRequestFile,
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

/** Brief 74 — surfaced to apps/web so the New Request tab's Location
 *  dropdown has the data it needs without a second fetch. The shape is
 *  the read-path's `UserAccessibleLocation` plus `location_name` (from
 *  MX `expand=location.name` on the work-order list — null when no WO
 *  has yet referenced this loc). The form filters to `maintainx_id !==
 *  null` (a request can't post to an unmapped location). */
interface AccessibleLocationOut {
  maintainx_id: number | null;
  location_address: string | null;
  location_name: string | null;
}

interface CurrentUserOut {
  email: string;
  /** Operator's MaintainX `full_name` (sourced from the cached
   *  `maintainx_users` row); null when no row matches their session
   *  email. apps/web defaults the Requester Name input to this when
   *  rendering the New Request tab. */
  full_name: string | null;
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
  /** Brief 74 — passed through to the New Request tab's form. */
  accessibleLocations: AccessibleLocationOut[];
  currentUser: CurrentUserOut;
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

      if (path === "workorders/api/request" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") {
          return buildRequestRedirect(request, "Sign in to file a work request.");
        }
        return handleCreateRequest(request, env, auth.session);
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

  // Brief 74 — operator's MaintainX `full_name` for the New Request tab's
  // requester-name default. Fail-soft: null when no row matches the
  // session email; apps/web falls back to an empty default.
  const mxUser = await getMaintainXUserByEmail(env, email).catch(() => null);
  const currentUser: CurrentUserOut = {
    email,
    full_name: mxUser?.full_name ?? null
  };

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
      email,
      accessibleLocations: buildAccessibleLocations(accessible, new Map()),
      currentUser
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

  // Brief 74 — harvest MX-side location names from the WO list so the
  // New Request tab's Location dropdown can label entries with the
  // human-readable name MX uses internally.
  const mxNamesByLocId = new Map<number, string>();
  for (const wo of result.workOrders) {
    const id = extractRawLocationId(wo);
    if (id == null || mxNamesByLocId.has(id)) continue;
    const name = extractRawLocationName(wo);
    if (name) mxNamesByLocId.set(id, name);
  }

  console.log(
    `workorders-worker list: email=${email} mappedMxIds=${mappedMxIds.length} paginate=${shouldPaginate} pageCount=${result.pageCount} workOrders=${result.workOrders.length} truncated=${result.truncated} droppedOverduePreventive=${buckets.droppedOverduePreventive}`
  );

  return json({
    reactive: { groups: reactive },
    preventive: { groups: preventive },
    fetchedAt,
    truncated: result.truncated,
    pageCount: result.pageCount,
    accessibleLocationCount: accessible.length,
    mappedLocationCount: mappedMxIds.length,
    email,
    accessibleLocations: buildAccessibleLocations(accessible, mxNamesByLocId),
    currentUser
  } satisfies ListResponse);
}

function buildAccessibleLocations(
  accessible: UserAccessibleLocation[],
  mxNamesByLocId: Map<number, string>
): AccessibleLocationOut[] {
  return accessible.map((loc) => ({
    maintainx_id: loc.maintainx_id,
    location_address: loc.location_address,
    location_name:
      loc.maintainx_id != null
        ? mxNamesByLocId.get(loc.maintainx_id) ?? null
        : null
  }));
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
 *
 * Brief 79: Preventive WOs whose `dueDate` is more than
 * `PREVENTATIVE_MAX_OVERDUE_DAYS` past today (UTC day-floor) are
 * dropped — they don't land in either bucket. NULL / malformed
 * dueDate Preventive WOs are kept. `droppedOverduePreventive` returns
 * the count for observability logging at the call site.
 */
function bucketByType(workOrders: RawWorkOrder[]): {
  reactive: RawWorkOrder[];
  preventive: RawWorkOrder[];
  droppedOverduePreventive: number;
} {
  const reactive: RawWorkOrder[] = [];
  const preventive: RawWorkOrder[] = [];
  let droppedOverduePreventive = 0;
  const nowMs = Date.now();
  const todayUtc = Math.floor(nowMs / 86_400_000);
  for (const wo of workOrders) {
    if (typeof wo.type === "string" && wo.type === "PREVENTIVE") {
      // Brief 79 — drop preventives more than 90 days overdue.
      if (typeof wo.dueDate === "string" && wo.dueDate.length > 0) {
        const dueMs = Date.parse(wo.dueDate);
        if (Number.isFinite(dueMs)) {
          const dueUtc = Math.floor(dueMs / 86_400_000);
          if (todayUtc - dueUtc > PREVENTATIVE_MAX_OVERDUE_DAYS) {
            droppedOverduePreventive += 1;
            continue;
          }
        }
      }
      preventive.push(wo);
    } else {
      reactive.push(wo);
    }
  }
  return { reactive, preventive, droppedOverduePreventive };
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

/**
 * Brief 79 — Preventive WOs whose `dueDate` is more than this many
 * days in the past are dropped from the response. The Preventative
 * tab on /workorders accumulates a long tail of stale auto-spawned
 * MaintainX preventive cycles; this trim keeps the tab focused on
 * what an operator can act on. NULL dueDate / unparseable dueDate
 * Preventive WOs are KEPT — only dated rows past the threshold
 * drop. Reactive WOs are never filtered (their dueDate is
 * MaintainX-auto-set to creation-day and not operationally
 * meaningful).
 */
const PREVENTATIVE_MAX_OVERDUE_DAYS = 90;

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

/* ============================================================
 * Brief 74 / Brief 75 / Brief 76 — POST /workorders/api/request:
 * create MaintainX work request + up to 5 photos (1 thumbnail + 4
 * attachments).
 *
 * Posture (mirrors Brief 37/38's damage-document upload path):
 *   - Plain HTML form posts here as multipart/form-data — bypasses
 *     Next 15 server actions (the OpenNext-on-CF-Workers runtime
 *     has flaky multipart-server-action behavior; the legacy plain-
 *     form path is reliable on iPhone Safari and Chrome alike).
 *   - Email-on-locations gate: same `getLocationsByContactEmail`
 *     membership check as the read path. No location → 403-shaped
 *     redirect.
 *   - On success: 303 redirect to apps/web's /workorders?tab=new
 *     &request_ok=<id> (with optional &request_warn=N-of-M-photos-failed
 *     when some uploads failed post-create). Failure: same redirect
 *     with request_error query.
 *   - Per-upload AbortController timeout: 15s. The handler can run
 *     for up to ~90s (1 create × 15s + 5 uploads × 15s) — acceptable
 *     for a user-driven submit.
 *
 * Brief 75 (2026-05-08): retired Brief 74's multi-photo path on the
 * (wrong) assumption that work requests only support a thumbnail.
 *
 * Brief 76 (2026-05-08): the actual MaintainX URL is
 * /v1/workrequests/{id}/attachments/{filename} — plural. Brief 74
 * built it singular based on the doc heading text. Multi-photo
 * restored: photo[0] → thumbnail, photo[1..4] → attachments.
 * Phone-required from Brief 75 is preserved.
 * ============================================================ */

const REQUEST_REDIRECT_PATH = "/workorders";
const REQUEST_REDIRECT_TAB = "new";
const REQUEST_ERROR_MAX_LEN = 240;
const REQUEST_TITLE_MAX_LEN = 120;
const REQUEST_DESCRIPTION_MAX_LEN = 4000;
const REQUEST_REQUESTER_NAME_MAX_LEN = 80;
const REQUEST_REQUESTER_PHONE_MAX_LEN = 30;
const REQUEST_FILENAME_MAX_LEN = 80;
const REQUEST_PHOTO_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const REQUEST_MAX_PHOTOS = 5;
const REQUEST_PER_UPLOAD_TIMEOUT_MS = 15_000;
const REQUEST_CREATE_TIMEOUT_MS = 15_000;
const REQUEST_ALLOWED_PRIORITIES = new Set<"HIGH" | "MEDIUM" | "LOW">([
  "HIGH",
  "MEDIUM",
  "LOW"
]);

function buildRequestRedirect(
  request: Request,
  errorMessage: string | null,
  successId: number | null = null,
  warning: string | null = null
): Response {
  const originHeader = request.headers.get("Origin");
  const origin =
    originHeader && /^https?:\/\//.test(originHeader)
      ? originHeader
      : new URL(request.url).origin;

  const params = new URLSearchParams();
  params.set("tab", REQUEST_REDIRECT_TAB);
  if (successId != null) {
    params.set("request_ok", String(successId));
    if (warning) {
      // Brief 76: `photo_warn=N-of-M-photos-failed` stacks under the
      // success banner client-side. Brief 75 used `request_warn` for the
      // same purpose; rename matches the brief's spec and avoids
      // overloading "request_*" with both error- and photo-fail
      // semantics.
      params.set(
        "photo_warn",
        warning.slice(0, REQUEST_ERROR_MAX_LEN)
      );
    }
  } else if (errorMessage) {
    params.set(
      "request_error",
      errorMessage.slice(0, REQUEST_ERROR_MAX_LEN)
    );
  }
  return Response.redirect(
    `${origin}${REQUEST_REDIRECT_PATH}?${params.toString()}`,
    303
  );
}

function sanitizeFilename(rawName: string): string {
  // Strip leading dots so a hidden file ("..bashrc") doesn't slip through;
  // anything outside [a-zA-Z0-9._-] becomes "_". Lowercase the extension
  // so "IMG.JPEG" and "img.jpeg" sort equivalently. Cap at 80 chars while
  // preserving the extension.
  let name = rawName.replace(/^\.+/, "");
  if (!name) name = "photo";
  // Split off extension (last dot only).
  const lastDot = name.lastIndexOf(".");
  let stem = lastDot > 0 ? name.slice(0, lastDot) : name;
  let ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  stem = stem.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Brief 76: collapse runs of consecutive underscores so "download (2).jpg"
  // → "download_2_.jpg" → "download_2_.jpg" instead of the awkward
  // "download__2_.jpg".
  stem = stem.replace(/_+/g, "_");
  ext = ext.replace(/[^a-zA-Z0-9]/g, "");
  let combined = ext ? `${stem}.${ext}` : stem;
  // Brief 76: trim a trailing "_" right before the extension —
  // "download_2_.jpg" → "download_2.jpg".
  if (ext) combined = combined.replace(/_+(\.[^.]+)$/, "$1");
  if (combined.length > REQUEST_FILENAME_MAX_LEN) {
    const cutTo = REQUEST_FILENAME_MAX_LEN - (ext ? ext.length + 1 : 0);
    const stemTrim = stem.slice(0, Math.max(1, cutTo));
    combined = ext ? `${stemTrim}.${ext}` : stemTrim;
    if (ext) combined = combined.replace(/_+(\.[^.]+)$/, "$1");
  }
  return combined || "photo";
}

async function handleCreateRequest(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (!isOriginAllowed(request)) {
    return buildRequestRedirect(request, "Bad origin.");
  }

  const email = session.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return buildRequestRedirect(request, "Sign in to file a work request.");
  }

  if (!env.MAINTAINX_API_KEY) {
    return buildRequestRedirect(
      request,
      "MaintainX integration not configured."
    );
  }

  const ctype = request.headers.get("content-type") ?? "";
  if (!ctype.includes("multipart/form-data")) {
    return buildRequestRedirect(
      request,
      "Work request must be multipart/form-data."
    );
  }

  // Email-on-locations gate (defense-in-depth alongside apps/web's
  // dropdown filter). Filing a request requires at least one mapped
  // location; super_admin / admin without their email on a locations
  // row are rejected here, matching the read path.
  const accessible = await getLocationsByContactEmail(env, email);
  const accessibleMxIds = new Set<number>();
  for (const loc of accessible) {
    if (loc.maintainx_id != null) accessibleMxIds.add(loc.maintainx_id);
  }
  if (accessibleMxIds.size === 0) {
    return buildRequestRedirect(
      request,
      "No MaintainX-mapped locations on your account — ask a super_admin to add your email."
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return buildRequestRedirect(request, "Could not parse form data.");
  }

  const title = String(form.get("title") ?? "").trim();
  const descriptionRaw = String(form.get("description") ?? "").trim();
  const priorityRaw = String(form.get("priority") ?? "").trim().toUpperCase();
  const requesterName = String(form.get("requester_name") ?? "").trim();
  const requesterPhone = String(form.get("requester_phone") ?? "").trim();
  const locationIdRaw = String(form.get("location_id") ?? "").trim();

  if (!title) return buildRequestRedirect(request, "Title is required.");
  if (title.length > REQUEST_TITLE_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Title is too long (max ${REQUEST_TITLE_MAX_LEN} characters).`
    );
  }
  if (!descriptionRaw) {
    return buildRequestRedirect(request, "Description is required.");
  }
  if (descriptionRaw.length > REQUEST_DESCRIPTION_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Description is too long (max ${REQUEST_DESCRIPTION_MAX_LEN} characters).`
    );
  }
  if (
    priorityRaw !== "HIGH" &&
    priorityRaw !== "MEDIUM" &&
    priorityRaw !== "LOW"
  ) {
    return buildRequestRedirect(request, "Priority must be HIGH, MEDIUM, or LOW.");
  }
  const priority = priorityRaw as "HIGH" | "MEDIUM" | "LOW";
  if (!REQUEST_ALLOWED_PRIORITIES.has(priority)) {
    return buildRequestRedirect(request, "Priority must be HIGH, MEDIUM, or LOW.");
  }
  if (!requesterName) {
    return buildRequestRedirect(request, "Requester name is required.");
  }
  if (requesterName.length > REQUEST_REQUESTER_NAME_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Requester name is too long (max ${REQUEST_REQUESTER_NAME_MAX_LEN} characters).`
    );
  }
  // Brief 75: phone is required. No format validation (operators may
  // legitimately enter international formats, extensions, etc.); just
  // non-empty.
  if (!requesterPhone) {
    return buildRequestRedirect(request, "requester_phone_required");
  }
  if (requesterPhone.length > REQUEST_REQUESTER_PHONE_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Requester phone is too long (max ${REQUEST_REQUESTER_PHONE_MAX_LEN} characters).`
    );
  }
  const locationId = Number.parseInt(locationIdRaw, 10);
  if (!Number.isFinite(locationId) || locationId <= 0) {
    return buildRequestRedirect(request, "Pick a location.");
  }
  if (!accessibleMxIds.has(locationId)) {
    return buildRequestRedirect(
      request,
      "Location not in your accessible set."
    );
  }

  // Brief 76: up to 5 photos — photo[0] → thumbnail endpoint,
  // photo[1..4] → attachments (plural) endpoint. Worker-side cap is
  // defense-in-depth alongside the form's client-side check.
  const allPhotoEntries = form.getAll("photo");
  const photoFiles: File[] = [];
  for (const entry of allPhotoEntries) {
    if (typeof entry === "string") continue; // empty multipart fields land as ""
    if (!(entry instanceof File)) continue;
    if (entry.size === 0) continue; // empty input
    if (entry.size > REQUEST_PHOTO_MAX_BYTES) {
      return buildRequestRedirect(
        request,
        `Photo "${entry.name}" is too large (max ${REQUEST_PHOTO_MAX_BYTES / (1024 * 1024)} MB).`
      );
    }
    photoFiles.push(entry);
  }
  if (photoFiles.length > REQUEST_MAX_PHOTOS) {
    return buildRequestRedirect(request, "too_many_photos");
  }

  // Compose description footer with requester attribution. Phone is now
  // required (Brief 75) so the placeholder fallback ("—") is gone.
  const description = `${descriptionRaw}\n\n---\nRequested by: ${requesterName}\nPhone: ${requesterPhone}\nSubmitted via: Splash /workorders`;

  // Phase 1 — create the work request.
  const createCtl = new AbortController();
  const createTimeout = setTimeout(
    () => createCtl.abort(),
    REQUEST_CREATE_TIMEOUT_MS
  );
  let createResult;
  try {
    createResult = await createMaintainXWorkRequest({
      title,
      description,
      priority,
      locationId,
      creatorContactInfo: email,
      apiKey: env.MAINTAINX_API_KEY,
      baseUrl: env.MAINTAINX_BASE_URL,
      signal: createCtl.signal
    });
  } finally {
    clearTimeout(createTimeout);
  }

  if (!createResult.ok || createResult.requestId == null) {
    console.error(
      `workorders-worker request create failed: status=${createResult.status} error=${createResult.error}`
    );
    return buildRequestRedirect(
      request,
      `Could not create the request: ${createResult.error ?? "upstream error"}`
    );
  }
  const requestId = createResult.requestId;

  // Phase 2 — upload up to 5 photos. photo[0] → thumbnail endpoint;
  // photo[1..4] → attachments (plural) endpoint. Failures are
  // non-fatal: the request exists in MaintainX either way. Per-photo
  // failures collect into a count surfaced via `request_warn=
  // {N}-of-{M}-photos-failed` on the success redirect.
  let photosFailed = 0;
  for (let i = 0; i < photoFiles.length; i += 1) {
    const file = photoFiles[i];
    if (!file) continue; // narrows tsconfig's noUncheckedIndexedAccess
    const endpoint: "thumbnail" | "attachment" = i === 0 ? "thumbnail" : "attachment";
    const filename = sanitizeFilename(file.name);
    let body: ArrayBuffer | null = null;
    try {
      body = await file.arrayBuffer();
    } catch (err) {
      console.error(
        `workorders-worker request ${requestId} photo ${i} (${endpoint}) read failed:`,
        err
      );
      photosFailed += 1;
      continue;
    }
    const uploadCtl = new AbortController();
    const uploadTimeout = setTimeout(
      () => uploadCtl.abort(),
      REQUEST_PER_UPLOAD_TIMEOUT_MS
    );
    let uploadResult;
    try {
      uploadResult = await uploadMaintainXWorkRequestFile({
        requestId,
        filename,
        body,
        apiKey: env.MAINTAINX_API_KEY,
        baseUrl: env.MAINTAINX_BASE_URL,
        endpoint,
        signal: uploadCtl.signal
      });
    } finally {
      clearTimeout(uploadTimeout);
    }
    if (!uploadResult.ok) {
      console.error(
        `workorders-worker request ${requestId} photo ${i} (${endpoint}) failed: status=${uploadResult.status} error=${uploadResult.error}`
      );
      photosFailed += 1;
    }
  }

  console.log(
    `workorders-worker request ${requestId} created by ${email} (photos=${photoFiles.length}, photos_failed=${photosFailed})`
  );

  const warn =
    photosFailed > 0
      ? `${photosFailed}-of-${photoFiles.length}-photos-failed`
      : null;
  return buildRequestRedirect(request, null, requestId, warn);
}
