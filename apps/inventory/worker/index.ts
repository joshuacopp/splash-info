// splash-inventory worker entry point.
//
// Owns BOTH the ported inventory SPA (served from ./dist via Cloudflare Static
// Assets) AND its JSON API, path-carved at splashcarwashes.info/inventory/*.
//
//   /inventory/api/*  -> gated JSON API (this file), backed by worker/db.ts
//   everything else   -> the SPA shell/assets via env.ASSETS.fetch()
//
// run_worker_first=true (wrangler.toml) routes every request here first; we
// strip the /inventory prefix, handle /api/* ourselves, and forward the rest to
// the asset store (which SPA-falls-back to index.html for client routes).
//
// Auth: every /api/* route passes through inventoryGate (authenticate + the
// `inventory` tool grant). Location scope is enforced per-write via
// userCanAccessLocation; full-admin writes (products, recipients, edit/delete
// visits) require super_admin (isInventoryAdmin).

import { json, jsonError } from "@splash/http";
import type { SupabaseClient } from "@splash/db-supabase";
import { inventoryGate, isInventoryAdmin, userCanAccessLocation } from "./auth.js";
import {
  createVisit,
  deleteVisit,
  getVisitLocationCode,
  loadInventoryData,
  resolveFlag,
  savePackageConfig,
  saveRecipients,
  sendVisitReport,
  unresolveFlag,
  updateVisit,
  upsertProduct
} from "./db.js";
import type { Env } from "./env.js";

const ROUTE_PREFIX = "/inventory";

async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // Path-carve prefix strip. Prod serves under /inventory/*; after the strip
    // the router reads "/api/..." and asset paths read "/assets/...". On the
    // workers.dev fallback the prefix is absent, so the strip is a no-op.
    if (pathname === ROUTE_PREFIX) pathname = "/";
    else if (pathname.startsWith(ROUTE_PREFIX + "/")) pathname = pathname.slice(ROUTE_PREFIX.length);

    const segments = pathname.split("/").filter(Boolean);

    // ---- Static SPA (non-API) --------------------------------------------
    if (segments[0] !== "api") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = pathname || "/";
      return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    }

    // ---- API -------------------------------------------------------------
    try {
      const gate = await inventoryGate(request, env);
      if (!gate.ok) return gate.response;
      const { session, sb } = gate;
      const method = request.method;
      const sub = segments[1];

      // GET /api/me — session + scope for the SPA's AuthContext.
      if (sub === "me" && segments.length === 2) {
        if (method !== "GET") return jsonError(405, "method not allowed");
        return json({
          authenticated: true,
          email: session.email,
          role: session.role,
          isAdmin: isInventoryAdmin(session),
          canSubmit: true,
          locations: session.locations
        });
      }

      // GET /api/data — the full dataset (scoped + location_code->location_id).
      if (sub === "data" && segments.length === 2) {
        if (method !== "GET") return jsonError(405, "method not allowed");
        return json(await loadInventoryData(sb, session));
      }

      // /api/visits (create) and /api/visits/{id} (edit | delete)
      if (sub === "visits") {
        if (segments.length === 2) {
          if (method !== "POST") return jsonError(405, "method not allowed");
          const body = await readJson(request);
          const code = String(body.location_id || "");
          if (!code || !userCanAccessLocation(session, code)) {
            return jsonError(403, "forbidden for that location");
          }
          return json(await createVisit(sb, body));
        }
        if (segments.length === 3) {
          const visitId = decodeURIComponent(segments[2]!);
          if (method === "PUT" || method === "DELETE") {
            if (!isInventoryAdmin(session)) return jsonError(403, "admin only");
            if (method === "PUT") return json(await updateVisit(sb, visitId, await readJson(request)));
            await deleteVisit(sb, visitId);
            return json({ ok: true });
          }
          return jsonError(405, "method not allowed");
        }
      }

      // POST /api/products — upsert (admin only)
      if (sub === "products" && segments.length === 2) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        if (!isInventoryAdmin(session)) return jsonError(403, "admin only");
        return json(await upsertProduct(sb, await readJson(request)));
      }

      // POST /api/package-config — body { locationId, payload }
      if (sub === "package-config" && segments.length === 2) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const body = await readJson<{ locationId?: string; payload?: Record<string, unknown> }>(request);
        const code = String(body.locationId || "");
        if (!code || !userCanAccessLocation(session, code)) {
          return jsonError(403, "forbidden for that location");
        }
        return json(await savePackageConfig(sb, code, body.payload || {}));
      }

      // POST /api/recipients — full-list replace (admin only). Body: array.
      if (sub === "recipients" && segments.length === 2) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        if (!isInventoryAdmin(session)) return jsonError(403, "admin only");
        const list = await readJson<Array<Record<string, unknown>>>(request);
        return json(await saveRecipients(sb, Array.isArray(list) ? list : []));
      }

      // POST /api/report — recompute the visit report and enqueue it onto the
      // shared outbound_emails queue (Power Automate delivers).
      //
      // Body is { visitId, resend? } and nothing else is read. The worker
      // reloads the visit, its previous visit and the location's products from
      // the database and recomputes every number through the same calc.js the
      // Visit Detail page uses, so the email cannot drift from the screen and a
      // caller cannot dictate what the email claims.
      //
      // Scoped like every other write. This endpoint sends mail from a splash
      // address carrying a location's cost figures, so it needs the same check
      // POST /api/visits has — without it any holder of the `inventory` grant
      // could name someone else's site and mail that site's managers.
      //
      // The origin is taken from the request, not the body, so the "View Full
      // Visit" link lands on the host the operator is actually using.
      if (sub === "report" && segments.length === 2) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const body = await readJson<{ visitId?: string; resend?: boolean }>(request);
        const visitId = String(body.visitId || "").trim();
        if (!visitId) return jsonError(400, "visitId is required");

        // The location comes from the STORED visit, not the body. Every other
        // field a caller sends is ignored — which is also why a browser tab
        // still holding the previous client keeps working after this deploy:
        // that payload was fat, but it already carried visitId.
        const code = await getVisitLocationCode(sb, visitId);
        if (!code) return jsonError(404, "visit not found");
        if (!userCanAccessLocation(session, code)) {
          return jsonError(403, "forbidden for that location");
        }
        // Resend is admin-only. The automatic send is idempotent on visit id,
        // so this flag is the only way to mail a site's managers twice.
        if (body.resend && !isInventoryAdmin(session)) return jsonError(403, "admin only");

        return json(await sendVisitReport(sb, env, url.origin, { visitId, resend: !!body.resend }));
      }

      // /api/flags/resolve | /api/flags/unresolve
      if (sub === "flags" && segments.length === 3) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const op = segments[2];
        const body = await readJson(request);
        if (op === "resolve") {
          const code = String(body.locationId || "");
          if (!code || !userCanAccessLocation(session, code)) {
            return jsonError(403, "forbidden for that location");
          }
          const resolvedBy = String(body.resolvedBy || session.email);
          return json(
            await resolveFlag(sb, String(body.flagKey || ""), resolvedBy, code, (body.note as string) || null)
          );
        }
        if (op === "unresolve") {
          const flagKey = String(body.flagKey || "");
          // Scope-check via the stored flag's location before deleting.
          const code = await getFlagLocationCode(sb, flagKey);
          if (code && !userCanAccessLocation(session, code)) {
            return jsonError(403, "forbidden for that location");
          }
          await unresolveFlag(sb, flagKey);
          return json({ ok: true });
        }
      }

      return jsonError(404, "not found");
    } catch (err) {
      console.error("inventory-worker request failed:", url.pathname, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  }
} satisfies ExportedHandler<Env>;

// Small helper kept here (not db.ts) because it's only used for the unresolve
// scope check — reads the stored flag's location_code.
async function getFlagLocationCode(sb: SupabaseClient, flagKey: string) {
  if (!flagKey) return null;
  const { data } = await sb
    .schema("inventory")
    .from("flag_resolutions")
    .select("location_code")
    .eq("flag_key", flagKey)
    .maybeSingle();
  return (data?.location_code as string | undefined) ?? null;
}
