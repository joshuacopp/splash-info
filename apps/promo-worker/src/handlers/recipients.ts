// Brief 158b — location list + recipient resolution + promo-user search.
// Brief 158a's Phase 7 stub problem (no @supabase/supabase-js dep on
// apps/web, no SUPABASE_* bindings on splash-web) bites Brief 158b's
// Phase 2 (multi-select), Phase 6 (recipient pre-population), and Phase 7
// (assignee autocomplete) the same way — moving all three reads into the
// promo-worker keeps apps/web service-binding-pure and reuses the
// per-worker `SUPABASE_SERVICE_KEY` binding.
//
// Routes:
//   GET /promo/api/locations                          — list all enabled locations
//   GET /promo/api/locations/recipients?codes=loc1,...  — bulk resolve contact emails
//   GET /promo/api/users/search?q=...                   — autocomplete promo-role users
//
// Auth: any non-null promoRole (same posture as the GET /promos detail —
// these emails are already visible to anyone who can see the locations
// attached to a promo, just consolidated here for the modal's UX).
//
// Reads `pricing_simple.am_email / rm_email / site_email` for each code,
// flattens, dedupes case-insensitively (preserving first-occurrence
// casing), and returns sorted. Fail-soft per location: a fetch throw on
// one code does NOT collapse the response — that code just contributes
// no emails. Bounded to 200 codes per request as defense in depth (a
// realistic promo has 1–60 locations).

import { authenticate } from "@splash/auth";
import { gatePromoRole, getLocationContactInfo } from "@splash/db-supabase";
import { jsonError } from "@splash/http";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";

const LOCATION_CODE_RE = /^[a-z0-9_-]+$/;
const CODES_PER_REQUEST_MAX = 200;

async function gateCaller(
  env: Env,
  req: Request
): Promise<{ ok: true; promoRole: PromoRole } | { ok: false; response: Response }> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const gate = gatePromoRole(auth.session.promoRole, []);
  if (!gate.isAuthorized || !gate.promoRole) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return { ok: true, promoRole: gate.promoRole };
}

export async function handleResolveRecipients(
  req: Request,
  env: Env
): Promise<Response> {
  if (!env.SUPABASE_SERVICE_KEY) return jsonError(503, "service_key_unbound");

  const gate = await gateCaller(env, req);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const codesRaw = url.searchParams.get("codes");
  if (!codesRaw) {
    return jsonError(400, "bad_request");
  }

  const seen = new Set<string>();
  const codes: string[] = [];
  for (const raw of codesRaw.split(",")) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    if (!LOCATION_CODE_RE.test(trimmed)) {
      return jsonError(400, "bad_request");
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    codes.push(trimmed);
  }
  if (codes.length === 0) {
    return new Response(
      JSON.stringify({ recipients: [] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      }
    );
  }
  if (codes.length > CODES_PER_REQUEST_MAX) {
    return jsonError(400, "too_many_codes");
  }

  // Parallel fan-out — getLocationContactInfo is a single PostgREST GET per
  // code. Real-world promos top out around 60 locations so this is well
  // within Cloudflare's subrequest budget.
  const results = await Promise.all(
    codes.map((code) => getLocationContactInfo(env, code))
  );

  const deduped = new Map<string, string>(); // lowercase → original casing
  for (const r of results) {
    for (const email of [r.am_email, r.rm_email, r.site_email]) {
      if (!email) continue;
      const trimmed = email.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!deduped.has(key)) deduped.set(key, trimmed);
    }
  }

  const recipients = Array.from(deduped.values()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  return new Response(
    JSON.stringify({ recipients }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    }
  );
}

// =============================================================================
// GET /promo/api/locations — list all locations for the create-promo form
// =============================================================================

interface LocationListRow {
  location_code: string;
  location_pretty: string | null;
  site: string | null;
}

interface LocationListItem {
  locationCode: string;
  locationPretty: string;
  site: string | null;
}

export async function handleListLocations(
  req: Request,
  env: Env
): Promise<Response> {
  if (!env.SUPABASE_SERVICE_KEY) return jsonError(503, "service_key_unbound");

  const gate = await gateCaller(env, req);
  if (!gate.ok) return gate.response;

  // pricing_simple has one row per package per location; we want one entry
  // per location_code. PostgREST doesn't support DISTINCT directly, so we
  // read the unique columns + dedupe in code. The trg_sync_pricing_simple
  // trigger keeps location_pretty + site denormalized across all rows in a
  // given location_code, so first-occurrence wins is safe.
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("select", "location_code,location_pretty,site");
  url.searchParams.set("order", "location_pretty.asc,location_code.asc");
  url.searchParams.set("limit", "5000");

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[promo.locations] pricing_simple fetch threw", err);
    return jsonError(500, "locations_list_failed");
  }
  if (!resp.ok) {
    console.error("[promo.locations] pricing_simple returned", resp.status);
    return jsonError(500, "locations_list_failed");
  }
  const rows = (await resp.json().catch(() => [])) as LocationListRow[];

  const seen = new Set<string>();
  const items: LocationListItem[] = [];
  for (const r of rows) {
    if (!r.location_code) continue;
    const code = r.location_code.trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const pretty =
      (typeof r.location_pretty === "string" && r.location_pretty.trim()) ||
      code;
    items.push({
      locationCode: code,
      locationPretty: pretty,
      site:
        typeof r.site === "string" && r.site.trim() ? r.site.trim() : null
    });
  }

  // PostgREST's order=location_pretty.asc holds across the de-dupe.
  return new Response(JSON.stringify({ locations: items }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

// =============================================================================
// GET /promo/api/users/search?q=… — promo-role user autocomplete
// =============================================================================

interface PromoUserRow {
  user_id: string;
  email: string;
  promo_role: PromoRole | null;
}

interface PromoUserItem {
  userId: string;
  email: string;
  promoRole: PromoRole;
}

const USER_SEARCH_LIMIT = 20;

export async function handleSearchPromoUsers(
  req: Request,
  env: Env
): Promise<Response> {
  if (!env.SUPABASE_SERVICE_KEY) return jsonError(503, "service_key_unbound");

  const gate = await gateCaller(env, req);
  if (!gate.ok) return gate.response;

  // Restrict the autocomplete to IT-tier callers — only they assign people.
  // (The PostgREST query is already promo_role-scoped server-side; this
  // extra gate keeps the user-list off the wire for marketing / ops
  // accounts who don't need it.)
  if (gate.promoRole !== "super_admin" && gate.promoRole !== "it") {
    return jsonError(403, "forbidden");
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  const queryUrl = new URL("/rest/v1/auth_unified", env.SUPABASE_URL);
  queryUrl.searchParams.set("select", "user_id,email,promo_role");
  queryUrl.searchParams.set("promo_role", "not.is.null");
  queryUrl.searchParams.set("order", "email.asc");
  queryUrl.searchParams.set("limit", String(USER_SEARCH_LIMIT));
  if (q) {
    const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
    queryUrl.searchParams.set("email", `ilike.*${escaped}*`);
  }

  let resp: Response;
  try {
    resp = await fetch(queryUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[promo.users.search] fetch threw", err);
    return jsonError(500, "user_search_failed");
  }
  if (!resp.ok) {
    console.error("[promo.users.search] returned", resp.status);
    return jsonError(500, "user_search_failed");
  }
  const rows = (await resp.json().catch(() => [])) as PromoUserRow[];

  const items: PromoUserItem[] = rows
    .filter((r) => r.user_id && r.email && r.promo_role)
    .map((r) => ({
      userId: r.user_id,
      email: r.email,
      promoRole: r.promo_role as PromoRole
    }));

  return new Response(JSON.stringify({ users: items }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
