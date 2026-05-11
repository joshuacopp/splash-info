// Splash JotForm Worker — entry point (Brief 107).
//
// Routes:
//   GET  /                                                  — health (200)
//   POST /jotform/webhook/{token}/{form_id}                  — JotForm webhook
//   GET  /admin/jotform/api/forms                            — list enabled forms + counts
//   GET  /admin/jotform/api/{form_id}/submissions            — paginated list (per-form)
//   GET  /admin/jotform/api/{form_id}/submissions/{id}       — single-row detail
//   GET  /admin/jotform/api/{form_id}/submissions.csv        — CSV export (schema-union)
//   POST /admin/jotform/api/{form_id}/backfill?after_id=...  — super_admin backfill
//
// See ./handlers/admin.js and ./handlers/webhook.js for handler shape.

import { jsonError } from "@splash/http";
import { handleAdminApi } from "./handlers/admin.js";
import { handleWebhook } from "./handlers/webhook.js";

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

  if (path.startsWith("/admin/jotform/api/")) {
    const out = await handleAdminApi(request, env, ctx);
    return out ?? jsonError(404, "not found");
  }

  return jsonError(404, "not found");
}
