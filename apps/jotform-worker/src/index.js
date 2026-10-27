// Splash JotForm Worker — entry point (Brief 107 / Brief 110).
//
// Routes:
//   GET  /                                                  — health (200)
//   POST /jotform/webhook/{token}/{form_id}                  — JotForm webhook
//   GET  /admin/jotform/api/forms                            — list enabled forms + counts
//   GET  /admin/jotform/api/roster                           — RD/RM/location roster (Brief 110)
//   GET  /admin/jotform/api/{form_id}/submissions            — paginated list (per-form)
//   GET  /admin/jotform/api/{form_id}/submissions/{id}       — single-row detail
//   GET  /admin/jotform/api/{form_id}/submissions.csv        — CSV export (schema-union)
//   POST /admin/jotform/api/{form_id}/backfill?after_id=...  — super_admin backfill
//   /admin/jotform/api/golden-ticket/*                       — CRD work queue (golden-ticket/admin.js)
//   GET  /jotform/golden-ticket/{token}[/check|/photo/{id}]  — no-login plate lookup (golden-ticket/public.js)
//
// See ./handlers/admin.js and ./handlers/webhook.js for handler shape.

import { jsonError } from "@splash/http";
import { handleAdminApi } from "./handlers/admin.js";
import { handleWebhook } from "./handlers/webhook.js";
import { handleGoldenTicketPublic } from "./golden-ticket/public.js";

const WEBHOOK_RE = /^\/jotform\/webhook\/([^/]+)\/([A-Za-z0-9_-]+)$/;

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  }
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Health check for CF / uptime monitors. No body — just a 200.
  if (path === "/" || path === "") {
    return new Response("splash-jotform OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  const wh = path.match(WEBHOOK_RE);
  if (wh) {
    return handleWebhook(request, env, ctx, wh[1], wh[2]);
  }

  // Golden Ticket site lookup. A wrong token returns null and falls through
  // to the plain 404 below, indistinguishable from any unknown path.
  if (path.startsWith("/jotform/golden-ticket/")) {
    const rest = path.slice("/jotform/golden-ticket/".length).split("/").filter(Boolean);
    const out = await handleGoldenTicketPublic(request, env, rest);
    if (out) return out;
    return jsonError(404, "not found");
  }

  if (path.startsWith("/admin/jotform/api/")) {
    const out = await handleAdminApi(request, env, ctx);
    return out ?? jsonError(404, "not found");
  }

  return jsonError(404, "not found");
}
