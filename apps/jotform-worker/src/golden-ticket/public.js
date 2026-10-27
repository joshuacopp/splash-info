// Golden Ticket — site "already won?" lookup. No login.
//
//   GET /jotform/golden-ticket/{token}                         page
//   GET /jotform/golden-ticket/{token}/check?plate=ABC1234     JSON result
//   GET /jotform/golden-ticket/{token}/photo/{id}?plate=...    earlier win's photo
//
// Rides the jotform-worker's existing splashcarwashes.info/jotform/* route,
// so no new Cloudflare route. The token is the ONLY gate. It lives in
// golden_ticket_settings (not a wrangler secret) so an admin can replace it
// or switch the page off from /admin/golden-ticket -- a leaked link or the
// end of a promo needs no CLI. A wrong token, or the page switched off,
// answers exactly like any unknown path.
//
// NO BROWSING. Staff must type a plate; nothing lists wins. A result shows
// only the date, site, prize and the ticket-next-to-plate photo of earlier
// wins for THAT plate -- no name or phone. The photo route re-checks that the
// plate typed matches the win, because JotForm submission ids are
// time-ordered and therefore guessable: without the plate check the token
// alone would open every winner's photo.

import { jsonError } from "@splash/http";
import {
  ASSET_PATH_PREFIXES,
  buildAssetHostAllowList,
  fetchJotformAssetFollowingRedirects
} from "../handlers/admin.js";
import {
  constantTimeEqual,
  listPromos,
  loadSettings,
  lookupPromo,
  normalizePlate,
  sb,
  todayEastern
} from "./shared.js";
import { renderLookupPage } from "./page.js";

const PRIVACY = {
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store"
};

const SUBMISSION_ID_RE = /^[0-9]{6,30}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...PRIVACY }
  });
}

/**
 * `rest` = path parts after "jotform/golden-ticket". Returns null for
 * anything not ours (wrong token included) so the caller 404s.
 */
export async function handleGoldenTicketPublic(request, env, rest) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const token = rest[0] ? safeDecode(rest[0]) : "";
  if (!token) return null;

  let settings;
  try {
    settings = await loadSettings(env);
  } catch (err) {
    console.error("[golden-ticket] settings read failed", err);
    return jsonError(503, "Lookup is unavailable right now. Try again in a minute.");
  }
  if (!settings.lookup_token || !constantTimeEqual(settings.lookup_token, token)) return null;

  const base = `/jotform/golden-ticket/${encodeURIComponent(token)}`;
  try {
    if (rest.length === 1) {
      return new Response(request.method === "HEAD" ? null : renderLookupPage({ base }), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVACY }
      });
    }
    if (rest.length === 2 && rest[1] === "check") return await check(request, env, base);
    if (rest.length === 3 && rest[1] === "photo") return await photo(request, env, rest[2]);
  } catch (err) {
    console.error("[golden-ticket] public handler failed", err);
    return jsonError(500, "Something went wrong. Try again.");
  }
  return null;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}

async function check(request, env, base) {
  const plate = normalizePlate(new URL(request.url).searchParams.get("plate"));
  if (plate.length < 2 || plate.length > 10) {
    return json({ ok: false, error: "Enter the license plate (letters and numbers)." }, 400);
  }

  const promos = await listPromos(env);
  const today = todayEastern();
  const promo = lookupPromo(promos, today);
  if (!promo) {
    return json({ ok: true, plate, promo: null, wins: [] });
  }

  const rows =
    (await sb(env, "golden_ticket_wins", {
      query: {
        plate_norm: `eq.${plate}`,
        promo_id: `eq.${promo.id}`,
        status: "neq.void",
        select: "submission_id,won_on,site_name,site_number,prize,prize_code,photo_url",
        order: "submitted_at.asc"
      }
    })) ?? [];

  return json({
    ok: true,
    plate,
    promo: {
      name: promo.name,
      starts_on: promo.starts_on,
      ends_on: promo.ends_on,
      running: promo.starts_on <= today && today <= promo.ends_on
    },
    wins: rows.map((r) => ({
      won_on: r.won_on,
      site: r.site_name || (r.site_number ? `Site ${r.site_number}` : "Unknown site"),
      prize: r.prize,
      prize_code: r.prize_code,
      photo: r.photo_url
        ? `${base}/photo/${encodeURIComponent(r.submission_id)}?plate=${encodeURIComponent(plate)}`
        : null
    }))
  });
}

async function photo(request, env, rawId) {
  const id = safeDecode(rawId);
  const plate = normalizePlate(new URL(request.url).searchParams.get("plate"));
  if (!SUBMISSION_ID_RE.test(id) || plate.length < 2) return jsonError(404, "not found");

  const rows = await sb(env, "golden_ticket_wins", {
    query: { submission_id: `eq.${id}`, plate_norm: `eq.${plate}`, select: "photo_url", limit: "1" }
  });
  const photoUrl = Array.isArray(rows) && rows[0] ? rows[0].photo_url : null;
  if (!photoUrl) return jsonError(404, "not found");
  if (!env.JOTFORM_API_KEY) return jsonError(503, "Photos are unavailable right now.");

  let target;
  try {
    target = new URL(photoUrl);
  } catch {
    return jsonError(404, "not found");
  }
  const allowed = buildAssetHostAllowList(env);
  if (!allowed.has(target.host) || !ASSET_PATH_PREFIXES.some((p) => target.pathname.startsWith(p))) {
    console.warn("[golden-ticket] photo url outside JotForm allow-list", target.host);
    return jsonError(404, "not found");
  }
  target.searchParams.set("apikey", env.JOTFORM_API_KEY);
  const got = await fetchJotformAssetFollowingRedirects(target, env.JOTFORM_API_KEY, allowed);
  if (!got.ok) return got.response;
  if (!got.response.ok) return jsonError(got.response.status === 404 ? 404 : 502, "Photo unavailable.");

  return new Response(got.response.body, {
    status: 200,
    headers: {
      "Content-Type": got.response.headers.get("Content-Type") || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Cache-Control": "private, max-age=300"
    }
  });
}
