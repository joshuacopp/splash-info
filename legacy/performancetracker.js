// =====================================================
// Performance Tracker - Cloudflare Worker
// =====================================================
// Routes:
//   GET  /                    -> HTML app (login or app shell)
//   POST /api/login           -> Supabase email/password login, sets cookie
//   POST /api/logout          -> clears cookie
//   GET  /api/me              -> { email } or 401
//   GET  /api/locations?q=... -> search locations by site_number or site_name
//   POST /api/submissions     -> create a performance_tracking row
//   GET  /api/submissions     -> list w/ filters (date range, location, greeter, gm, agm)
// =====================================================

import { HTML } from "./ui.js";

const COOKIE_NAME = "sb-access-token";
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

// The Worker is mounted at `/pertrack/*` via the route pattern in wrangler.toml.
// Strip that prefix so our route table stays clean (`/`, `/api/...`).
const ROUTE_PREFIX = "/pertrack";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let { pathname } = url;

    // Normalize the prefix.
    if (pathname === ROUTE_PREFIX) {
      // e.g. splashcarwashes.info/pertrack -> redirect to trailing slash so
      // relative links in the HTML resolve correctly.
      return Response.redirect(url.origin + ROUTE_PREFIX + "/", 302);
    }
    if (pathname.startsWith(ROUTE_PREFIX + "/")) {
      pathname = pathname.slice(ROUTE_PREFIX.length);  // "/pertrack/api/me" -> "/api/me"
    }

    try {
      if (pathname === "/" || pathname === "/index.html") {
        // SSO: if not authenticated, bounce to dashboard
        const access = await checkToolAccess(request, env, "pertrack");
        if (access.status === "unauthenticated") {
          return Response.redirect(`${url.origin}/?redirect=/pertrack/`, 302);
        }
        if (access.status === "forbidden") {
          return html(renderForbidden(access.user.email), 403);
        }
        return html(HTML);
      }

      if (pathname === "/api/login"       && request.method === "POST")  return apiLogin(request, env);
      if (pathname === "/api/logout"      && request.method === "POST")  return apiLogout();
      if (pathname === "/api/me"          && request.method === "GET")   return apiMe(request, env);

      // Everything below requires auth + pertrack tool grant
      const access = await checkToolAccess(request, env, "pertrack");
      if (access.status === "unauthenticated") return json({ error: "unauthorized" }, 401);
      if (access.status === "forbidden") return json({ error: "forbidden" }, 403);
      const user = access.user;

      if (pathname === "/api/locations"   && request.method === "GET")   return apiLocations(url, env);
      if (pathname === "/api/submissions" && request.method === "POST")  return apiCreateSubmission(request, env, user);
      if (pathname === "/api/submissions" && request.method === "GET")   return apiListSubmissions(url, env);

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || "server error" }, 500);
    }
  }
};

// ------------------------------------------------------
// Auth
// ------------------------------------------------------
async function apiLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return json({ error: "email and password required" }, 400);

  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: data.error_description || data.msg || "login failed" }, 401);

  // Store the Supabase access token in an HttpOnly cookie.
  // Path=/ so it works on both the custom route and the .workers.dev fallback.
  const cookie = [
    `${COOKIE_NAME}=${data.access_token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join("; ");

  return new Response(JSON.stringify({ email: data.user?.email }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
  });
}

function apiLogout() {
  const cookie = `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
  });
}

async function apiMe(request, env) {
  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  return json({ email: user.email, id: user.id });
}

async function requireUser(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;

  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!r.ok) return null;
  return r.json();
}

// Returns: 'authorized' | 'forbidden' | 'unauthenticated'
// Plus the user object when relevant.
async function checkToolAccess(request, env, tool) {
  const user = await requireUser(request, env);
  if (!user) return { status: "unauthenticated", user: null };

  // Super admins bypass tool_access checks entirely
  const permResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user.id}&role=eq.super_admin&select=role`,
    { headers: sbHeaders(env) }
  );
  if (permResp.ok) {
    const perms = await permResp.json();
    if (Array.isArray(perms) && perms.length > 0) {
      return { status: "authorized", user };
    }
  }

  // Otherwise check user_tool_access
  const toolResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_tool_access?user_id=eq.${user.id}&tool=eq.${tool}&select=tool`,
    { headers: sbHeaders(env) }
  );
  if (toolResp.ok) {
    const grants = await toolResp.json();
    if (Array.isArray(grants) && grants.length > 0) {
      return { status: "authorized", user };
    }
  }

  return { status: "forbidden", user };
}

function getCookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  const match = h.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

// ------------------------------------------------------
// Supabase helpers (service role - bypasses RLS)
// ------------------------------------------------------
function sbHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// ------------------------------------------------------
// Locations
// ------------------------------------------------------
async function apiLocations(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const params = new URLSearchParams();
  params.set(
    "select",
    "id,site_number,site,location,mla_location,area_manager,regional_manager,rm_group,rm_email,am_email,hrt_email,site_email,hrt1,hrt2,fivestar"
  );
  params.set("order", "site_number.asc");
  params.set("limit", "20");

  if (q) {
    const needle = q.replace(/[(),*]/g, "");
    // If the query is purely numeric, search both site_number (exact-ish prefix)
    // and site name. Otherwise just search the text columns.
    const clauses = [];
    if (/^\d+$/.test(needle)) {
      // site_number is integer; PostgREST can't ilike on int, so use eq
      // for exact match + ilike on casted text via text columns.
      clauses.push(`site_number.eq.${needle}`);
    }
    clauses.push(`site.ilike.*${needle}*`);
    clauses.push(`mla_location.ilike.*${needle}*`);
    clauses.push(`location.ilike.*${needle}*`);
    params.set("or", `(${clauses.join(",")})`);
  }

  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/locations?${params}`, {
    headers: sbHeaders(env),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: data.message || "locations query failed" }, 500);
  return json(data);
}

// ------------------------------------------------------
// Submissions - create
// ------------------------------------------------------
async function apiCreateSubmission(request, env, user) {
  const body = await request.json();

  // Validate required bits
  if (!body.location_id) return json({ error: "location_id is required" }, 400);

  const row = {
    visit_at:             body.visit_at || new Date().toISOString(),
    location_id:          Number(body.location_id),
    capture_rate:         toNumOrNull(body.capture_rate),
    opportunities:        toIntOrNull(body.opportunities),
    greeter_1_name:       trimOrNull(body.greeter_1_name),
    greeter_2_name:       trimOrNull(body.greeter_2_name),
    greeter_3_name:       trimOrNull(body.greeter_3_name),
    greeter_1_shift_start: body.greeter_1_shift_start || null,
    greeter_1_shift_end:   body.greeter_1_shift_end   || null,
    greeter_2_shift_start: body.greeter_2_shift_start || null,
    greeter_2_shift_end:   body.greeter_2_shift_end   || null,
    greeter_3_shift_start: body.greeter_3_shift_start || null,
    greeter_3_shift_end:   body.greeter_3_shift_end   || null,
    gm_on_site:           !!body.gm_on_site,
    gm_name:              trimOrNull(body.gm_name),
    agm_on_site:          !!body.agm_on_site,
    agm_name:             trimOrNull(body.agm_name),
    comments:             trimOrNull(body.comments),
    submitted_by:         user.id,
    submitted_by_email:   user.email,
  };

  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/performance_tracking`, {
    method: "POST",
    headers: sbHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: data.message || "insert failed", details: data }, 500);
  return json(Array.isArray(data) ? data[0] : data, 201);
}

// ------------------------------------------------------
// Submissions - list / filter
// ------------------------------------------------------
async function apiListSubmissions(url, env) {
  const sp = url.searchParams;
  const params = new URLSearchParams();

  // Use !inner on the locations embed so that filters on `locations.*`
  // also drop parent performance_tracking rows whose location doesn't match.
  params.set(
    "select",
    "id,visit_at,capture_rate,opportunities," +
      "greeter_1_name,greeter_2_name,greeter_3_name," +
      "greeter_1_shift_start,greeter_1_shift_end," +
      "greeter_2_shift_start,greeter_2_shift_end," +
      "greeter_3_shift_start,greeter_3_shift_end," +
      "gm_on_site,gm_name,agm_on_site,agm_name," +
      "comments,submitted_by_email,created_at," +
      "location:locations!inner(id,site_number,site,mla_location,location,area_manager,regional_manager,rm_group,rm_email,am_email,hrt_email,site_email,hrt1,hrt2,fivestar)"
  );
  params.set("order", "visit_at.desc");
  params.set("limit", sp.get("limit") || "200");

  // Date range
  if (sp.get("date_from")) params.append("visit_at", `gte.${sp.get("date_from")}`);
  if (sp.get("date_to"))   params.append("visit_at", `lte.${sp.get("date_to")}`);

  // Location filter (by id)
  if (sp.get("location_id")) params.set("location_id", `eq.${sp.get("location_id")}`);

  // GM / AGM filters
  if (sp.get("gm_on_site"))  params.set("gm_on_site",  `eq.${sp.get("gm_on_site")}`);
  if (sp.get("agm_on_site")) params.set("agm_on_site", `eq.${sp.get("agm_on_site")}`);

  // Name searches - greeter across the 3 columns, plus gm/agm names
  const greeter = (sp.get("greeter") || "").trim();
  const gmName  = (sp.get("gm_name") || "").trim();
  const agmName = (sp.get("agm_name") || "").trim();

  if (greeter) {
    const g = greeter.replace(/[(),]/g, "");
    params.append(
      "or",
      `(greeter_1_name.ilike.*${g}*,greeter_2_name.ilike.*${g}*,greeter_3_name.ilike.*${g}*)`
    );
  }
  if (gmName)  params.set("gm_name",  `ilike.*${gmName.replace(/[(),]/g, "")}*`);
  if (agmName) params.set("agm_name", `ilike.*${agmName.replace(/[(),]/g, "")}*`);

  // Filters that live on the `locations` embed. PostgREST lets us filter
  // embedded resources with the `locations.<col>` param syntax, which will
  // also drop parent rows where no locations row matches (inner-join-like)
  // — exactly what we want here.
  const rm  = (sp.get("regional_manager") || "").trim();
  const am  = (sp.get("area_manager")     || "").trim();
  const rmGroup  = sp.get("rm_group");
  const fivestar = sp.get("fivestar");

  if (rm)       params.set("locations.regional_manager", `ilike.*${rm.replace(/[(),]/g, "")}*`);
  if (am)       params.set("locations.area_manager",     `ilike.*${am.replace(/[(),]/g, "")}*`);
  if (rmGroup)  params.set("locations.rm_group", `eq.${rmGroup}`);
  if (fivestar) params.set("locations.fivestar", `eq.${fivestar}`);

  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/performance_tracking?${params}`, {
    headers: sbHeaders(env),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: data.message || "query failed", details: data }, 500);
  return json(data);
}

// ------------------------------------------------------
// utils
// ------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function html(s, status = 200) {
  return new Response(s, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function renderForbidden(email) {
  const safeEmail = String(email || "this account")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<title>Access Denied — Performance Tracker</title>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --splash-navy: #1c164e;
    --racecar-red: #dc3e26;
    --white: #ffffff;
    --muted: #6b7280;
    --radius-sm: 6px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    background-attachment: fixed;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 460px;
    background: var(--white);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .card-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: #fff;
    padding: 28px 32px 22px;
    text-align: center;
  }
  .card-header img { display: block; height: 56px; width: auto; margin: 0 auto 12px; }
  .card-header .eyebrow {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .card-header h1 { margin: 0; font-size: 1.25rem; font-weight: 700; color: #fff; }
  .card-body { padding: 24px 32px 28px; text-align: center; }
  .card-body p { margin: 0 0 8px; font-size: 14px; color: var(--splash-navy); }
  .card-body .email { font-weight: 700; word-break: break-all; }
  .card-body .muted { color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
  .btn {
    padding: 10px 20px; height: 42px;
    font: 700 14px var(--font-body);
    border-radius: var(--radius-sm); cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center;
    border: none;
  }
  .btn-primary {
    background: var(--splash-blue); color: #fff;
    box-shadow: var(--shadow-btn);
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
      <div class="eyebrow">Performance Tracker</div>
      <h1>Access Denied</h1>
    </div>
    <div class="card-body">
      <p>Sorry, <span class="email">${safeEmail}</span> doesn't have access to Performance Tracker.</p>
      <p class="muted">Contact your administrator if you need access.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/">Return to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
function trimOrNull(v) { if (v == null) return null; const t = String(v).trim(); return t ? t : null; }
function toNumOrNull(v) { if (v === "" || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; }
function toIntOrNull(v) { if (v === "" || v == null) return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; }