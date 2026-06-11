// Brief 167 — "Notify removed sites" handler.
//
// Symmetric twin of Brief 164's `handleNotifyCompletedSites` (build-phase
// notify). Where the build-phase fires when IT marks a site COMPLETE, the
// removal-phase fires when IT marks a site REMOVED (teardown done) and
// wants to inform the field that the special is no longer active.
//
// Single endpoint:
//
//   POST /promo/api/promos/{id}/notify-removed-sites
//
// Auth: `super_admin | it`. CSRF: `isOriginAllowed`. Body: `{ note?:
// string, includeRm?: boolean, includeRd?: boolean }` (Brief 166 opt-in
// pattern; default false for both, site_email always implied).
//
// Flow:
//   1. Read `promotions` row by id; 404 if missing. Capture `title` +
//      `promo_type` for the email.
//   2. Query `promo_locations` where `promo_id = {id} AND is_removed =
//      true AND removal_notified_at IS NULL` (eligible removed-sites).
//      Empty result → 200 `{ok, notifiedCount: 0, ...}` so the FAB can
//      surface a quiet "No new sites to notify" banner.
//   3. Per site: inline `pricing_simple` fetch (`location_pretty` +
//      `am_email` + `rm_email` + `site_email`); dedup recipients
//      case-insensitively per-site (NOT globally — each site gets its
//      own email, mirroring Brief 164/166).
//   4. Render via `renderRemovalNotify`; enqueue one `outbound_emails`
//      row per recipient with `source_kind: 'promo-site-removal-notify'`
//      + `source_id: "{promoId}:{locationCode}"`.
//   5. On all-success per site: PATCH `removal_notified_at = now()` +
//      `removal_notified_by = session.userId`; emit ONE
//      `removal_site_notified` activity log row.
//   6. Any enqueue failure → location stays un-notified for retry;
//      surfaces in `failedLocations[]`.
//
// Dedup posture (same two layers as Brief 164):
//   (a) eligible-sites query filters out already-notified rows;
//   (b) `outbound_emails` unique tuple `(promo-worker,
//       promo-site-removal-notify, "{promoId}:{locationCode}",
//       recipient)` suppresses dup writes if (a) is bypassed.
//
// Operator-forced re-notify after a site re-tear-down requires clearing
// `removal_notified_at` AND deleting the matching `outbound_emails` row,
// same workaround as Brief 164.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";
import { authenticate } from "@splash/auth";
import { gatePromoRole } from "@splash/db-supabase";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";
import { logActivity } from "./_activity.js";
import { renderRemovalNotify } from "../announce/render-removal-notify.js";

const PROMO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX_LEN = 500;

interface NotifyBody {
  note?: unknown;
  includeRm?: unknown;
  includeRd?: unknown;
}

const KNOWN_BODY_KEYS = new Set(["note", "includeRm", "includeRd"]);

function pgHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface GateOk {
  ok: true;
  session: { userId: string; email: string; promoRole: PromoRole };
}
interface GateErr {
  ok: false;
  response: Response;
}

async function gateCaller(
  env: Env,
  req: Request,
  requiredRoles: PromoRole[]
): Promise<GateOk | GateErr> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const { session } = auth;
  const gate = gatePromoRole(session.promoRole, requiredRoles);
  if (!gate.isAuthorized || !gate.promoRole) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return {
    ok: true,
    session: {
      userId: session.userId,
      email: session.email,
      promoRole: gate.promoRole
    }
  };
}

/**
 * Resolve the apps/web origin for "View promo details" links inside the
 * notification body. Mirrors `notify-sites.ts`'s `resolveAppsWebBase`.
 */
function resolveAppsWebBase(env: Env, request: Request | null): string {
  const fallback = env.APPS_WEB_BASE_URL || "https://splashcarwashes.info";
  if (!request) return fallback;
  try {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".workers.dev")) {
      return fallback;
    }
    if (url.hostname.endsWith("splashcarwashes.info")) {
      return `${url.protocol}//${url.hostname}`;
    }
  } catch {
    // fall through
  }
  return fallback;
}

interface PromoTitleRow {
  title: string;
  promo_type: string;
}

interface EligibleLocationRow {
  location_code: string;
}

interface SiteContactRow {
  location_pretty: string | null;
  am_email: string | null;
  rm_email: string | null;
  site_email: string | null;
}

interface SiteResolution {
  locationCode: string;
  locationPretty: string;
  recipients: string[];
}

interface NotifySiteResult {
  locationCode: string;
  recipientCount: number;
  removalNotifiedAt: string;
}

export async function handleNotifyRemovedSites(
  req: Request,
  env: Env,
  promoId: string
): Promise<Response> {
  if (!env.SUPABASE_SERVICE_KEY) return jsonError(503, "service_key_unbound");
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  // Body — `{ note?: string, includeRm?: boolean, includeRd?: boolean }`.
  // Empty body is the common case.
  let bodyText = "";
  let includeRm = false;
  let includeRd = false;
  try {
    if (req.headers.get("content-length") !== "0") {
      const raw = await req.json().catch(() => null);
      if (raw !== null) {
        if (!isPlainObject(raw)) return jsonError(400, "bad_request");
        const body = raw as NotifyBody;
        for (const k of Object.keys(body)) {
          if (!KNOWN_BODY_KEYS.has(k)) return jsonError(400, "bad_request");
        }
        if ("note" in body) {
          const v = body.note;
          if (v === null || v === undefined) {
            bodyText = "";
          } else if (typeof v === "string") {
            const trimmed = v.trim();
            if (trimmed.length > NOTE_MAX_LEN) {
              return new Response(
                JSON.stringify({
                  error: "bad_request",
                  fields: { note: "too_long" }
                }),
                { status: 400, headers: { "Content-Type": "application/json" } }
              );
            }
            bodyText = trimmed;
          } else {
            return new Response(
              JSON.stringify({
                error: "bad_request",
                fields: { note: "invalid" }
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        if ("includeRm" in body) {
          const v = body.includeRm;
          if (v === undefined || v === null) {
            includeRm = false;
          } else if (typeof v === "boolean") {
            includeRm = v;
          } else {
            return new Response(
              JSON.stringify({
                error: "bad_request",
                fields: { includeRm: "invalid" }
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        if ("includeRd" in body) {
          const v = body.includeRd;
          if (v === undefined || v === null) {
            includeRd = false;
          } else if (typeof v === "boolean") {
            includeRd = v;
          } else {
            return new Response(
              JSON.stringify({
                error: "bad_request",
                fields: { includeRd: "invalid" }
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
        }
      }
    }
  } catch {
    return jsonError(400, "bad_request");
  }
  const note: string | null = bodyText.length > 0 ? bodyText : null;

  // Step 1 — read promo title + promo_type. Doubles as the 404 check.
  let promoTitle: string;
  let promoType: string;
  try {
    const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${promoId}`);
    url.searchParams.set("select", "title,promo_type");
    url.searchParams.set("limit", "1");
    const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.notify-removed-sites] promo fetch failed",
        resp.status,
        errText
      );
      return jsonError(500, "notify_failed");
    }
    const rows = (await resp.json().catch(() => [])) as PromoTitleRow[];
    if (!rows[0]) return jsonError(404, "promo_not_found");
    promoTitle = rows[0].title;
    promoType = rows[0].promo_type;
  } catch (err) {
    console.error("[promo.notify-removed-sites] promo fetch threw", err);
    return jsonError(500, "notify_failed");
  }

  // Step 2 — eligible sites (`is_removed = true AND removal_notified_at IS NULL`).
  let eligibleCodes: string[];
  try {
    const url = new URL("/rest/v1/promo_locations", env.SUPABASE_URL);
    url.searchParams.set("promo_id", `eq.${promoId}`);
    url.searchParams.set("is_removed", "eq.true");
    url.searchParams.set("removal_notified_at", "is.null");
    url.searchParams.set("select", "location_code");
    url.searchParams.set("order", "location_code.asc");
    const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.notify-removed-sites] eligible-sites fetch failed",
        resp.status,
        errText
      );
      return jsonError(500, "notify_failed");
    }
    const rows = (await resp.json().catch(() => [])) as EligibleLocationRow[];
    eligibleCodes = rows
      .map((r) => (typeof r.location_code === "string" ? r.location_code : ""))
      .filter((c) => c.length > 0);
  } catch (err) {
    console.error("[promo.notify-removed-sites] eligible-sites fetch threw", err);
    return jsonError(500, "notify_failed");
  }

  if (eligibleCodes.length === 0) {
    return jsonResponse({
      ok: true,
      notifiedCount: 0,
      sites: [],
      skippedCount: 0,
      failedLocations: [],
      message: "No new sites to notify"
    });
  }

  // Step 3 — per-site contact resolution (parallel; fail-soft per site).
  const resolutions: Array<SiteResolution | null> = await Promise.all(
    eligibleCodes.map(async (code): Promise<SiteResolution | null> => {
      try {
        const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
        url.searchParams.set("location_code", `eq.${code}`);
        url.searchParams.set(
          "select",
          "location_pretty,am_email,rm_email,site_email"
        );
        url.searchParams.set("limit", "1");
        const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
        if (!resp.ok) {
          console.error(
            `[promo.notify-removed-sites] pricing_simple fetch failed for ${code}`,
            resp.status
          );
          return null;
        }
        const rows = (await resp.json().catch(() => [])) as SiteContactRow[];
        const row = rows[0];
        if (!row) {
          console.error(
            `[promo.notify-removed-sites] pricing_simple row missing for ${code}`
          );
          return null;
        }
        const pretty =
          typeof row.location_pretty === "string" && row.location_pretty.trim()
            ? row.location_pretty.trim()
            : code;
        // Brief 166 opt-in posture: site_email always; rm_email when
        // includeRm; am_email (= Regional Director per the CLAUDE.md
        // label-vs-data mapping) when includeRd.
        const candidates: Array<string | null> = [row.site_email];
        if (includeRm) candidates.push(row.rm_email);
        if (includeRd) candidates.push(row.am_email);
        const recipients: string[] = [];
        const seen = new Set<string>();
        for (const raw of candidates) {
          if (typeof raw !== "string") continue;
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          recipients.push(trimmed);
        }
        return { locationCode: code, locationPretty: pretty, recipients };
      } catch (err) {
        console.error(
          `[promo.notify-removed-sites] pricing_simple fetch threw for ${code}`,
          err
        );
        return null;
      }
    })
  );

  const appsWebBase = resolveAppsWebBase(env, req);
  const liveViewUrl = `${appsWebBase}/admin/promotions/${promoId}`;

  const notifiedSites: NotifySiteResult[] = [];
  const failedLocations: string[] = [];
  let skippedCount = 0;

  for (let i = 0; i < eligibleCodes.length; i++) {
    const code = eligibleCodes[i]!;
    const res = resolutions[i];
    if (!res) {
      failedLocations.push(code);
      continue;
    }
    if (res.recipients.length === 0) {
      skippedCount += 1;
      continue;
    }

    // Render the email body once per site; reused across recipients.
    let rendered: ReturnType<typeof renderRemovalNotify>;
    try {
      rendered = renderRemovalNotify({
        promoTitle,
        promoType,
        locationCode: res.locationCode,
        locationPretty: res.locationPretty,
        notifiedByEmail: gate.session.email,
        note,
        liveViewUrl
      });
    } catch (err) {
      console.error(
        `[promo.notify-removed-sites] render threw for ${code} (fail-soft):`,
        err
      );
      failedLocations.push(code);
      continue;
    }

    const subject = `The ${promoTitle} special has ended at ${res.locationPretty}`;
    const sourceId = `${promoId}:${res.locationCode}`;

    let perSiteFailed = false;
    for (const recipient of res.recipients) {
      try {
        await enqueueOutboundEmail(env, {
          source_worker: "promo-worker",
          source_kind: "promo-site-removal-notify",
          source_id: sourceId,
          recipient,
          subject,
          body_text: rendered.plainText,
          body_html: rendered.html,
          attachments: []
        });
      } catch (err) {
        console.error(
          `[promo.notify-removed-sites] enqueue failed for ${recipient} @ ${code}:`,
          err
        );
        perSiteFailed = true;
      }
    }

    if (perSiteFailed) {
      failedLocations.push(code);
      continue;
    }

    // All enqueues succeeded — stamp removal_notified_at + removal_notified_by
    // and emit the activity log row.
    const nowIso = new Date().toISOString();
    let stampOk = false;
    try {
      const url = new URL("/rest/v1/promo_locations", env.SUPABASE_URL);
      url.searchParams.set("promo_id", `eq.${promoId}`);
      url.searchParams.set("location_code", `eq.${code}`);
      const resp = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          ...pgHeaders(env),
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          removal_notified_at: nowIso,
          removal_notified_by: gate.session.userId
        })
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(
          `[promo.notify-removed-sites] PATCH stamp failed for ${code}`,
          resp.status,
          errText
        );
      } else {
        stampOk = true;
      }
    } catch (err) {
      console.error(
        `[promo.notify-removed-sites] PATCH stamp threw for ${code}`,
        err
      );
    }

    if (!stampOk) {
      // Emails are queued + the dedup tuple protects re-fires; surface
      // as a failure so the operator notices the stamp drift.
      failedLocations.push(code);
      continue;
    }

    await logActivity(
      env,
      promoId,
      gate.session.userId,
      "removal_site_notified",
      {
        locationCode: code,
        recipientCount: res.recipients.length,
        ...(note ? { note } : {})
      }
    );

    notifiedSites.push({
      locationCode: code,
      recipientCount: res.recipients.length,
      removalNotifiedAt: nowIso
    });
  }

  return jsonResponse({
    ok: true,
    notifiedCount: notifiedSites.length,
    sites: notifiedSites,
    skippedCount,
    failedLocations
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
