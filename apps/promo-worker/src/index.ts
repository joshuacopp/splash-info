// Splash Promotions Worker — Brief 153 scaffolding + Brief 154 promo CRUD
// (list, create, detail) + Brief 155 ticket / status / assignee / location
// progress writes + Brief 156 materials upload/delete/serve + PTP upsert
// + Brief 157 announcement send (snapshot + outbound_emails fan-out).
//
// Hosts the internal-tooling JSON API for the promotions feature.
// Subsequent briefs layer apps/web pages (Brief 158) on top of the
// contracts established here.
//
// Routes:
//   GET     /promo/api/ping                                                   — sanity check (binding flags)
//   GET     /promo/api/promos                                                 — list with filters + counts
//   POST    /promo/api/promos                                                 — create promo + ticket + locations + log
//   GET     /promo/api/promos/{id}                                            — full detail tree (incl. announcements[])
//   PATCH   /promo/api/promos/{id}/ticket                                     — Brief 155: edit ready_by / roadblocks / internal_note
//   PATCH   /promo/api/promos/{id}/status                                     — Brief 155: set promotions.status
//   POST    /promo/api/promos/{id}/assignees                                  — Brief 155: add an IT assignee
//   DELETE  /promo/api/promos/{id}/assignees/{userId}                         — Brief 155: remove an IT assignee
//   PATCH   /promo/api/promos/{id}/locations/{locationCode}                   — Brief 155: toggle per-location done
//   POST    /promo/api/promos/{id}/materials                                  — Brief 156: upload a material (multipart)
//   DELETE  /promo/api/promos/{id}/materials/{materialId}                     — Brief 156: remove a material + R2 object
//   GET     /promo/api/promos/{id}/materials/{materialId}/file                — Brief 156: stream the R2 object
//   PUT     /promo/api/promos/{id}/ptp                                        — Brief 156: upsert Purpose / Tools / Process doc
//   POST    /promo/api/promos/{id}/announce                                   — Brief 157: snapshot + fan out to outbound_emails
//   GET     /promo/api/announce/templates                                     — Brief 163: list fillable announcement templates
//   OPTIONS *                                                                 — 204 (CORS preflight no-op)
//   *                                                                         — 404
//
// Auth posture (Brief 154–157): every endpoint reads `session.promoRole`
// via `gatePromoRole`. List + detail + serve-material accept any
// non-null role; create requires {super_admin, it, marketing}. Ticket /
// assignee / location writes require {super_admin, it}; status write
// also accepts marketing (campaign-end flips). Material upload/delete
// + PTP upsert + announcement send require {super_admin, it, marketing}.
// Mutations also gate on `isOriginAllowed`; the GET serve route skips
// CSRF (read-only, same-origin GETs don't carry Origin per spec).

import { jsonError } from "@splash/http";
import {
  handleListPromos,
  handleCreatePromo,
  handleGetPromo
} from "./handlers/promos.js";
import {
  handlePatchTicket,
  handlePatchStatus,
  handleAddAssignee,
  handleRemoveAssignee,
  handlePatchLocationProgress
} from "./handlers/promo-writes.js";
import {
  handleUploadMaterial,
  handleDeleteMaterial,
  handleServeMaterialFile
} from "./handlers/materials.js";
import { handlePutPtp } from "./handlers/ptp.js";
import {
  handleSendAnnouncement,
  handlePreviewAnnouncement,
  handleListAnnouncementTemplates
} from "./handlers/announce.js";
import {
  handleResolveRecipients,
  handleListLocations,
  handleSearchPromoUsers
} from "./handlers/recipients.js";
import { handleNotifyCompletedSites } from "./handlers/notify-sites.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_ANON_KEY: string;
  PROMO_FILES: R2Bucket;
  /** Brief 162 — apps/web origin for "Open IT ticket" / "View promo
   *  overview" CTAs inside outbound notification emails. workers.dev
   *  request origins get rewritten to this value because workers.dev
   *  does not host the apps/web admin UI. */
  APPS_WEB_BASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // Smoke endpoint — sanity check that bindings resolved and the worker boots.
    if (url.pathname === "/promo/api/ping" && request.method === "GET") {
      return Response.json({
        ok: true,
        worker: "splash-promo",
        timestamp: new Date().toISOString(),
        bindings: {
          supabase_url_set: Boolean(env.SUPABASE_URL),
          supabase_service_key_set: Boolean(env.SUPABASE_SERVICE_KEY),
          supabase_anon_key_set: Boolean(env.SUPABASE_ANON_KEY),
          promo_files_bound: Boolean(env.PROMO_FILES)
        }
      });
    }

    // GET /promo/api/promos — list with filters + counts.
    // POST /promo/api/promos — create promo + seed ticket + seed locations + log.
    if (url.pathname === "/promo/api/promos") {
      if (request.method === "GET") return handleListPromos(request, env);
      if (request.method === "POST") return handleCreatePromo(request, env, ctx);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // GET /promo/api/promos/{id} — detail tree.
    const detailMatch = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)$/i);
    if (detailMatch && detailMatch[1]) {
      if (request.method === "GET") return handleGetPromo(request, env, detailMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 155 — write surfaces under /promo/api/promos/{id}/...
    //
    // Ticket / status / location PATCHes + assignee POST/DELETE. Each
    // handler runs its own promoRole gate + isOriginAllowed CSRF check.
    const ticketMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/ticket$/i
    );
    if (ticketMatch && ticketMatch[1]) {
      if (request.method === "PATCH")
        return handlePatchTicket(request, env, ticketMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    const statusMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/status$/i
    );
    if (statusMatch && statusMatch[1]) {
      if (request.method === "PATCH")
        return handlePatchStatus(request, env, statusMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    const assigneesMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/assignees$/i
    );
    if (assigneesMatch && assigneesMatch[1]) {
      if (request.method === "POST")
        return handleAddAssignee(request, env, assigneesMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    const assigneeMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/assignees\/([0-9a-f-]+)$/i
    );
    if (assigneeMatch && assigneeMatch[1] && assigneeMatch[2]) {
      if (request.method === "DELETE")
        return handleRemoveAssignee(
          request,
          env,
          assigneeMatch[1],
          assigneeMatch[2]
        );
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Note: NOT case-insensitive on the locationCode segment — slugs are
    // lowercase by Brief 153 convention. The promoId segment uses [a-f-]
    // which doesn't have case variants worth distinguishing, so omitting
    // the `i` flag here is harmless on that side too.
    const locationProgMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/locations\/([a-z0-9_-]+)$/
    );
    if (locationProgMatch && locationProgMatch[1] && locationProgMatch[2]) {
      if (request.method === "PATCH")
        return handlePatchLocationProgress(
          request,
          env,
          locationProgMatch[1],
          locationProgMatch[2]
        );
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 156 — material upload (POST list endpoint).
    const materialsMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/materials$/i
    );
    if (materialsMatch && materialsMatch[1]) {
      if (request.method === "POST")
        return handleUploadMaterial(request, env, ctx, materialsMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 156 — material file serve (more specific; matched before the
    // bare material id route below).
    const materialFileMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/materials\/([0-9a-f-]+)\/file$/i
    );
    if (materialFileMatch && materialFileMatch[1] && materialFileMatch[2]) {
      if (request.method === "GET")
        return handleServeMaterialFile(
          request,
          env,
          materialFileMatch[1],
          materialFileMatch[2]
        );
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 156 — material delete.
    const materialMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/materials\/([0-9a-f-]+)$/i
    );
    if (materialMatch && materialMatch[1] && materialMatch[2]) {
      if (request.method === "DELETE")
        return handleDeleteMaterial(
          request,
          env,
          materialMatch[1],
          materialMatch[2]
        );
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 156 — PTP upsert.
    const ptpMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/ptp$/i
    );
    if (ptpMatch && ptpMatch[1]) {
      if (request.method === "PUT")
        return handlePutPtp(request, env, ptpMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 163 — fillable announcement template registry. Any non-null
    // promoRole. Cached for 5 minutes (registry is code-defined). Path
    // is intentionally NOT under /promos/{id} because the registry is
    // global, not per-promo.
    if (url.pathname === "/promo/api/announce/templates") {
      if (request.method === "GET")
        return handleListAnnouncementTemplates(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 160 — announcement preview (no snapshot, no fan-out). Matched
    // BEFORE the bare `/announce` route so the more specific path wins.
    const announcePreviewMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/announce\/preview$/i
    );
    if (announcePreviewMatch && announcePreviewMatch[1]) {
      if (request.method === "POST")
        return handlePreviewAnnouncement(request, env, announcePreviewMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 157 — announcement send (snapshot + outbound_emails fan-out).
    const announceMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/announce$/i
    );
    if (announceMatch && announceMatch[1]) {
      if (request.method === "POST")
        return handleSendAnnouncement(request, env, ctx, announceMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 164 — per-site "IT changes are live" notification fire.
    // Matched BEFORE the `/announce` patterns to guarantee specificity.
    const notifySitesMatch = url.pathname.match(
      /^\/promo\/api\/promos\/([0-9a-f-]+)\/notify-completed-sites$/i
    );
    if (notifySitesMatch && notifySitesMatch[1]) {
      if (request.method === "POST")
        return handleNotifyCompletedSites(request, env, notifySitesMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 158b — bulk resolve location → recipient emails for the
    // announcement compose modal's pre-population. Path is intentionally
    // NOT under /promos/{id} because the same lookup is reused at promo-
    // creation time for the locations multiselect helper too. The more
    // specific `/recipients` route is matched BEFORE the bare list.
    if (url.pathname === "/promo/api/locations/recipients") {
      if (request.method === "GET")
        return handleResolveRecipients(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 158b — list all locations for the create-promo form's
    // multi-select. Any non-null promoRole.
    if (url.pathname === "/promo/api/locations") {
      if (request.method === "GET")
        return handleListLocations(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Brief 158b — promo-role user search for the IT ticket page's
    // assignee autocomplete. super_admin / it only.
    if (url.pathname === "/promo/api/users/search") {
      if (request.method === "GET")
        return handleSearchPromoUsers(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return jsonError(404, "Promo worker: route not found. See Brief 157+ for endpoint inventory.");
  }
};
