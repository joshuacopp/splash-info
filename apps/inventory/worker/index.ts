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
// Auth is THREE independent checks and a route needs all the ones that apply:
//
//   1. inventoryGate      — authenticated + holds any inventory grant. Opens
//                           the app. Read-only sessions (inventory_view) pass.
//   2. canWriteInventory  — required by every mutating route. A view-only
//                           session that POSTs anything must 403 here.
//   3. userCanAccessLocation — per-location scope, for routes that name a site
//                           OR name a row from which a site can be resolved.
//      isInventoryAdmin   — the admin-tier writes: DELETE a visit, products,
//                           recipients, report resend. NOT editing a visit —
//                           that moved down to the write tier on 2026-08-19.
//
// (2) is the one that's easy to forget, because until 2026-08-19 the gate
// itself implied write and mutating routes only had to check scope. Adding a
// POST without canWriteInventory now silently hands viewers write access.

import { json, jsonError } from "@splash/http";
import type { SupabaseClient } from "@splash/db-supabase";
import { canWriteInventory, inventoryGate, isInventoryAdmin, userCanAccessLocation } from "./auth.js";
import {
  ApiError,
  bulkUpdateProductPrices,
  createDelivery,
  createVisit,
  deleteVisit,
  getVisitLocationCode,
  loadInventoryData,
  loadMaintainXLocations,
  resolveFlag,
  savePackageConfig,
  saveRecipients,
  sendDeliveryReceipt,
  sendVisitReport,
  unresolveFlag,
  updateVisit,
  upsertProduct
} from "./db.js";
import type { Env } from "./env.js";
import {
  ORIGIN_TAG,
  REQUEST_MAX_PHOTOS,
  REQUEST_PHOTO_MAX_BYTES,
  createWorkRequest,
  listWorkRequests,
  maintainxConfig
} from "./maintainx.js";

const ROUTE_PREFIX = "/inventory";

async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

/* ---------------------------------------------------------------------------
 * POST /api/maintainx/requests — file a work request.
 *
 * multipart/form-data, because photos ride along. Every other route on this
 * worker is JSON; this one is the exception rather than a new convention.
 *
 * Field lengths mirror the form: `title` is the one-line problem (160), and
 * `description` carries a 50-character floor because a maintenance tech acting
 * on this can't do anything with "it's broken".
 * ------------------------------------------------------------------------ */

const REQUEST_TITLE_MAX = 160;
const REQUEST_DESCRIPTION_MIN = 50;
const REQUEST_DESCRIPTION_MAX = 4000;
const REQUEST_PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

function formString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function handleCreateRequest(
  request: Request,
  sessionEmail: string,
  config: { apiKey: string; baseUrl: string },
  locations: Array<{ id: string; name: string; maintainx_id: number }>
): Promise<Response> {
  const ctype = request.headers.get("content-type") || "";
  if (!ctype.includes("multipart/form-data")) {
    return jsonError(415, "Work request must be multipart/form-data.");
  }

  if (locations.length === 0) {
    return jsonError(
      422,
      "None of your locations are mapped to MaintainX yet. An admin needs to set maintainx_id on the site before requests can be filed."
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Could not read the submitted form.");
  }

  // Location — the id must be one of the caller's OWN mappable sites. This is
  // the authorization check, not a validation nicety: without it any operator
  // could file against any MaintainX location by editing the posted value.
  const locationId = Number.parseInt(formString(form, "location_id"), 10);
  const site = locations.find((l) => l.maintainx_id === locationId);
  if (!site) return jsonError(403, "forbidden for that location");

  const title = formString(form, "title");
  if (!title) return jsonError(422, "Describe the problem in one line.");
  if (title.length > REQUEST_TITLE_MAX) {
    return jsonError(422, `That one-line description is over ${REQUEST_TITLE_MAX} characters.`);
  }

  const detail = formString(form, "description");
  if (detail.length < REQUEST_DESCRIPTION_MIN) {
    return jsonError(
      422,
      `Add at least ${REQUEST_DESCRIPTION_MIN} characters of detail so the maintenance team can act on this.`
    );
  }
  if (detail.length > REQUEST_DESCRIPTION_MAX) {
    return jsonError(422, `Details are over ${REQUEST_DESCRIPTION_MAX} characters.`);
  }

  const priority = formString(form, "priority").toUpperCase();
  if (!REQUEST_PRIORITIES.has(priority)) {
    return jsonError(422, "Pick a priority.");
  }

  const requesterName = formString(form, "requester_name");
  if (!requesterName) return jsonError(422, "Enter the name of the person submitting this.");

  // Required. The signed-in email is frequently a shared site mailbox, so it
  // is not a way to reach the person who actually saw the problem — the
  // maintenance tech calls this number. Deliberately NOT format-validated:
  // extensions, mobile-vs-desk and however a site writes its own number are
  // all legitimate, and a regex here would reject real numbers to no benefit.
  const requesterPhone = formString(form, "requester_phone");
  if (!requesterPhone) return jsonError(422, "Enter a phone number for the person submitting.");
  if (requesterPhone.length > 30) return jsonError(422, "That phone number is too long.");

  // MaintainX has no created-at override and no requester-name field — its
  // `creatorContactInfo` is a contact identifier, for which the session email
  // is the reliable answer (a shared site login would otherwise attribute every
  // request to the same person). So the typed name and the submission date are
  // folded into the description, where they survive and stay readable, rather
  // than being dropped on the floor.
  //
  // The ORIGIN_TAG on the last line is load-bearing, not decoration: the list
  // route matches on it to show only requests filed from this app. Removing it
  // makes new requests invisible on the MaintainX Requests page.
  const submittedOn = formString(form, "submitted_on");
  const provenance = [
    `Filed by: ${requesterName}`,
    `Phone: ${requesterPhone}`,
    `Email: ${sessionEmail}`,
    submittedOn ? `Date of submission: ${submittedOn}` : null,
    `Site: ${site.name}`,
    `Submitted from Splash Chemical Inventory ${ORIGIN_TAG}`
  ]
    .filter(Boolean)
    .join("\n");
  const description = `${detail}\n\n---\n${provenance}`;

  // Photos. Empty file inputs arrive as "" strings in multipart, and a
  // zero-byte File is a browser artifact of an unfilled input — skip both.
  const photos: File[] = [];
  for (const entry of form.getAll("photo")) {
    if (typeof entry === "string") continue;
    if (entry.size === 0) continue;
    if (entry.size > REQUEST_PHOTO_MAX_BYTES) {
      return jsonError(
        413,
        `"${entry.name}" is too large (max ${REQUEST_PHOTO_MAX_BYTES / (1024 * 1024)} MB per photo).`
      );
    }
    photos.push(entry);
  }
  if (photos.length > REQUEST_MAX_PHOTOS) {
    return jsonError(422, `Attach at most ${REQUEST_MAX_PHOTOS} photos.`);
  }

  const result = await createWorkRequest(config, {
    title,
    description,
    priority: priority as "HIGH" | "MEDIUM" | "LOW",
    locationId: site.maintainx_id,
    creatorContactInfo: sessionEmail,
    photos
  });

  if (!result.ok) return jsonError(502, result.error || "MaintainX rejected the request.");

  // 200 with photosFailed > 0 is a real outcome, not a fudge: the request
  // exists in MaintainX and only some images are missing. The SPA says so.
  return json({
    ok: true,
    requestId: result.requestId,
    photosFailed: result.photosFailed,
    photosTotal: result.photosTotal
  });
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

      // Blanket write gate. Every read in this API is a GET and every mutation
      // is a POST/PUT/DELETE, so one check here covers the whole surface and —
      // more importantly — covers routes that don't exist yet. Per-route checks
      // would be equivalent today and wrong the first time someone adds an
      // endpoint without reading the header comment.
      //
      // Deliberately ahead of route matching, so an unknown POST 403s for a
      // viewer rather than 404ing. That leaks nothing: the caller already holds
      // an inventory grant and knows the app exists.
      if (method !== "GET" && method !== "HEAD" && !canWriteInventory(session)) {
        return jsonError(403, "read-only access");
      }

      // GET /api/me — session + scope for the SPA's AuthContext.
      //
      // canSubmit was hardcoded `true` while the single grant implied write.
      // It now carries the real answer, and the SPA uses it to hide mutation
      // affordances. Cosmetic only — the blanket check above is the control.
      //
      // allLocations is sent explicitly rather than inferred from isAdmin: the
      // two came apart when inventory_admin stopped implying super_admin, and a
      // location-scoped admin must not be told they see everything.
      if (sub === "me" && segments.length === 2) {
        if (method !== "GET") return jsonError(405, "method not allowed");
        return json({
          authenticated: true,
          email: session.email,
          role: session.role,
          isAdmin: isInventoryAdmin(session),
          canSubmit: canWriteInventory(session),
          allLocations: session.role === "super_admin",
          locations: session.locations
        });
      }

      // GET /api/data — the full dataset (scoped + location_code->location_id).
      if (sub === "data" && segments.length === 2) {
        if (method !== "GET") return jsonError(405, "method not allowed");
        return json(await loadInventoryData(sb, session));
      }

      // /api/maintainx/requests — list (GET) and file (POST) MaintainX work
      // requests. These proxy MaintainX directly; nothing is stored locally.
      //
      // Scope is enforced by resolving the caller's OWN locations server-side
      // and only ever using maintainx_ids drawn from that list. The client
      // sends a maintainx_id on POST, but it is checked against the resolved
      // set before use — a caller cannot file against a site they can't see by
      // posting someone else's id.
      if (sub === "maintainx" && segments[2] === "requests" && segments.length === 3) {
        if (method !== "GET" && method !== "POST") {
          return jsonError(405, "method not allowed");
        }

        // An unbound API key is a deployment state, not an error: report it and
        // let the SPA explain itself. 200 rather than 503 so the page can
        // render its own copy instead of a generic failure banner.
        const config = maintainxConfig(env);
        if (!config) {
          return json({
            configured: false,
            ok: true,
            requests: [],
            truncated: false,
            error: null
          });
        }

        const locations = await loadMaintainXLocations(sb, session);

        if (method === "GET") {
          const nameById = new Map(locations.map((l) => [l.maintainx_id, l.name]));
          const result = await listWorkRequests(
            config,
            locations.map((l) => l.maintainx_id),
            nameById
          );
          // Echo the mappable sites so the SPA can build its location dropdown
          // and its filter list from one round trip.
          return json({ ...result, locations });
        }

        return handleCreateRequest(request, session.email, config, locations);
      }

      // POST /api/deliveries — record a delivery (no car counts, no levels)
      // and queue its receipt.
      //
      // Same write tier and per-location scope as creating a visit: anyone who
      // can file a visit for a site can record a delivery to it. The blanket
      // non-GET gate above has already excluded read-only sessions.
      if (sub === "deliveries" && segments.length === 2) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const body = await readJson(request);
        const code = String(body.location_id || "");
        if (!code || !userCanAccessLocation(session, code)) {
          return jsonError(403, "forbidden for that location");
        }

        const created = await createDelivery(sb, {
          ...body,
          // Attribution comes from the session, not the payload.
          submitter: body.submitter || session.email
        });

        // The delivery is saved at this point. A failing receipt must not fail
        // the request and make the operator re-file a delivery that already
        // exists — report it and let them resend.
        let receipt: Awaited<ReturnType<typeof sendDeliveryReceipt>> | null = null;
        let receiptError: string | null = null;
        try {
          receipt = await sendDeliveryReceipt(sb, env, url.origin, {
            deliveryId: created.deliveryId
          });
        } catch (err) {
          receiptError = err instanceof Error ? err.message : String(err);
          console.error("[inventory.deliveries] receipt failed", receiptError);
        }

        return json({ ...created, receipt, receiptError });
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
          if (method !== "PUT" && method !== "DELETE") return jsonError(405, "method not allowed");

          // Scope comes from the STORED visit, not from anything the caller
          // sends. This block needed no location check at all until 2026-08-19,
          // because "admin" meant super_admin and super_admin is global — a
          // location-scoped admin (or, now, a location-scoped writer) makes that
          // assumption wrong, and without this a two-site user could PUT any
          // visit id in the system. updateVisit never writes location_code, so
          // the stored code is also the code after the edit.
          const code = await getVisitLocationCode(sb, visitId);
          if (!code) return jsonError(404, "visit not found");
          if (!userCanAccessLocation(session, code)) {
            return jsonError(403, "forbidden for that location");
          }

          // Editing is a WRITE, not an admin power (2026-08-19). The tech who
          // fat-fingers a reservoir count has to be able to correct it himself;
          // making that an admin errand means the wrong number sits in the data
          // until someone else is free. Viewers were already excluded by the
          // blanket non-GET gate above.
          if (method === "PUT") {
            return json(await updateVisit(sb, visitId, await readJson(request)));
          }

          // DELETE stays admin-only. It is the only irreversible action in this
          // API — the visit, its entries and its wash counts go together, and
          // there is no undo. Every honest fix a writer needs is reachable
          // through PUT, so the tier boundary sits here rather than at edit.
          if (!isInventoryAdmin(session)) return jsonError(403, "admin only");
          await deleteVisit(sb, visitId);
          return json({ ok: true });
        }
      }

      // POST /api/products — upsert (admin only)
      if (sub === "products" && segments.length === 2) {
        if (method !== "POST") return jsonError(405, "method not allowed");
        if (!isInventoryAdmin(session)) return jsonError(403, "admin only");
        return json(await upsertProduct(sb, await readJson(request)));
      }

      // POST /api/products/prices — bulk price update (admin only).
      //
      // Separate from POST /api/products rather than a mode of it, because the
      // two have genuinely different shapes: that one upserts ONE whole product
      // (and creates new ones), this one moves the price on many EXISTING ones
      // and touches no other column. Folding them together would mean a body
      // that means "create a product" and "reprice forty" depending on a flag.
      //
      // Admin-only for the same reason the single-product route is: products are
      // GLOBAL and unscoped, so there is no location check to make here — a
      // two-site inventory_admin repricing a chemical reprices it for every site
      // in the company. Worth knowing before widening this tier.
      //
      // Repricing is NOT retroactive, but only because of the price snapshot.
      // Each inventory_entries row stores the price_per_ml it was filed at
      // (supabase/inventory-entry-price-snapshot.sql) and calc.js prefers that
      // over the product's current price, so this endpoint changes what future
      // visits cost and nothing that has already been reported.
      //
      // That snapshot is a hard prerequisite for this route, not a nicety. Run
      // against a database where the migration has not been applied, the first
      // reprice here silently restates the chemical cost, blended CPC and
      // delivery value of every visit ever filed for the products it touches —
      // including ones already emailed to site managers — and the old prices are
      // gone for good, because nothing recorded them.
      if (sub === "products" && segments.length === 3 && segments[2] === "prices") {
        if (method !== "POST") return jsonError(405, "method not allowed");
        if (!isInventoryAdmin(session)) return jsonError(403, "admin only");
        // Optional-chained: readJson happily returns a literal `null` for a body
        // of "null", and `body.prices` on that is a TypeError — a 500 for what
        // is plainly a caller mistake. `undefined` falls through to the
        // "No price changes were submitted" 400 below.
        const body = await readJson<{ prices?: unknown }>(request);
        return json(await bulkUpdateProductPrices(sb, body?.prices));
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
      // ApiError means the caller got it wrong — a bad price, an unknown id —
      // and carries the status to say so. Everything else is ours and is a 500.
      // Not logged at error level, because a mistyped price is not an incident.
      if (err instanceof ApiError) return jsonError(err.status, err.message);
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
