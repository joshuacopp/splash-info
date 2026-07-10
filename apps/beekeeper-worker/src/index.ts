// beekeeper-worker entry point.
//
// Mounted on schedule.splashcarwashes.info/*. Two surfaces:
//   1. GET /{location_code}          — the single-file shift-editor UI shell
//   2. /api/loc/{location_code}/*    — the JSON API the UI talks to
//   3. POST /api/sync-users          — manual cache refill (super_admin / allowlist)
//
// The `scheduled` handler runs the daily cache sync (cron in wrangler.toml),
// mirroring the workorders-worker MaintainX posture: a warm cache is a nicety,
// the read paths still work (names just degrade to "User xxxxxxxx") if it lags.

import { jsonError } from "@splash/http";
import {
  handleContext,
  handleCreateShift,
  handleDeleteShift,
  handleListShifts,
  handleSyncUsers,
  handleUpdateShift
} from "./handlers.js";
import { renderScheduleUi } from "./ui.js";
import { runBeekeeperSync } from "./sync.js";
import type { Env } from "./env.js";

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/** Reserved first-segment paths that are NOT location codes. */
const RESERVED = new Set(["api", "favicon.ico", "robots.txt"]);

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method;

    try {
      // ---- Root ----------------------------------------------------------
      if (segments.length === 0) {
        return html(
          "<!doctype html><meta charset=utf-8><title>Splash Schedule</title>" +
            "<body style='font:15px system-ui;padding:40px;background:#0f172a;color:#e2e8f0'>" +
            "<h1>Splash Shift Schedule</h1><p>Open your location at " +
            "<code>schedule.splashcarwashes.info/{location_code}</code>.</p></body>",
          200
        );
      }

      // ---- API -----------------------------------------------------------
      if (segments[0] === "api") {
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

      // ---- UI shell:  GET /{location_code} -------------------------------
      if (segments.length === 1 && !RESERVED.has(segments[0]!)) {
        if (method !== "GET") return jsonError(405, "method not allowed");
        const locationCode = decodeURIComponent(segments[0]!);
        return html(renderScheduleUi(locationCode));
      }

      return new Response("Not found", { status: 404 });
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
