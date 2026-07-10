// beekeeper-worker entry point.
//
// API-ONLY surface, path-carved at splashcarwashes.info/schedule/api/*. The UI
// (location picker + week-grid calendar) lives in apps/web at app/schedule/*
// and reaches these endpoints via the BEEKEEPER_WORKER service binding (SSR)
// or same-origin browser fetches (interactive writes). Surfaces:
//   1. GET  /api/locations          — accessible location picker data
//   2. /api/loc/{location_code}/*   — the JSON API the UI talks to
//   3. POST /api/sync-users         — manual cache refill (super_admin / allowlist)
//
// The `scheduled` handler runs the daily cache sync (cron in wrangler.toml),
// mirroring the workorders-worker MaintainX posture: a warm cache is a nicety,
// the read paths still work (names just degrade to "User xxxxxxxx") if it lags.

import { jsonError } from "@splash/http";
import {
  handleContext,
  handleCreateShift,
  handleDeleteShift,
  handleListLocations,
  handleListShifts,
  handleSyncUsers,
  handleUpdateShift
} from "./handlers.js";
import { runBeekeeperSync } from "./sync.js";
import { ROUTE_PREFIX } from "./routePrefix.js";
import type { Env } from "./env.js";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let pathname = url.pathname;
    const method = request.method;

    // Path-carve prefix strip. Production serves under
    // splashcarwashes.info/schedule/api/*; after the strip the router below
    // reads paths naturally as "/api/...". On the workers.dev fallback the
    // prefix is absent, so the strip is a no-op.
    if (pathname.startsWith(ROUTE_PREFIX + "/")) {
      pathname = pathname.slice(ROUTE_PREFIX.length);
    }
    const segments = pathname.split("/").filter(Boolean);

    try {
      // ---- API -----------------------------------------------------------
      if (segments[0] === "api") {
        // GET /api/locations  — picker: accessible location_codes for the session
        if (segments[1] === "locations" && segments.length === 2) {
          if (method !== "GET") return jsonError(405, "method not allowed");
          return handleListLocations(request, env);
        }

        // POST /api/sync-users
        if (segments[1] === "sync-users" && segments.length === 2) {
          if (method !== "POST") return jsonError(405, "method not allowed");
          return handleSyncUsers(request, env);
        }

        // /api/loc/{location_code}/...
        if (segments[1] === "loc" && segments.length >= 3) {
          const locationCode = decodeURIComponent(segments[2]!);
          const rest = segments.slice(3); // e.g. [], ["context"], ["shifts"], ["shifts", "{id}"]

          if (rest.length === 1 && rest[0] === "context" && method === "GET") {
            return handleContext(request, env, locationCode);
          }

          if (rest[0] === "shifts") {
            // /shifts  (list | create)
            if (rest.length === 1) {
              if (method === "GET") return handleListShifts(request, env, locationCode);
              if (method === "POST") return handleCreateShift(request, env, locationCode);
              return jsonError(405, "method not allowed");
            }
            // /shifts/{shiftId}  (update | delete)
            if (rest.length === 2) {
              const shiftId = decodeURIComponent(rest[1]!);
              if (method === "PUT") return handleUpdateShift(request, env, locationCode, shiftId);
              if (method === "DELETE") return handleDeleteShift(request, env, locationCode, shiftId);
              return jsonError(405, "method not allowed");
            }
          }
        }

        return jsonError(404, "not found");
      }

      // Non-API paths are owned by apps/web (the ported React UI). This worker
      // is only routed /schedule/api/* in production, so anything else here is
      // a stray/dev request.
      return jsonError(404, "not found");
    } catch (err) {
      console.error("beekeeper-worker request failed:", url.pathname, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runBeekeeperSync(env);
          console.log("beekeeper-worker scheduled sync complete:", JSON.stringify(result));
        } catch (err) {
          console.error("beekeeper-worker scheduled sync failed:", err);
        }
      })()
    );
  }
} satisfies ExportedHandler<Env>;
