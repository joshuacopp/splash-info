/* ===================================================================
   SPLASH SYSADMIN WORKER 
   Route: splashcarwashes.info/sysadmin and /sysadmin/*

   ENV VARS 
   - SUPABASE_URL
   - SUPABASE_ANON_KEY
   - SUPABASE_SERVICE_KEY
=================================================================== */

addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request, event));
});

const ASSETS = {
  logoWhite: "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png",
  logoBlue:  "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full%20(1)%201.png",
  favicon:   "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png"
};

/* ===================== ROUTER ===================== */

async function handle(request, event) {
  const url = new URL(request.url);
  const rawPath = url.pathname.replace(/\/+$/, "") || "/";

  // Routes this worker actually owns
  const ownedPaths = new Set([
    "/sysadmin",
    "/sysadmin/users",
    "/sysadmin/users/detail",
    "/sysadmin/locations",
    "/sysadmin/api/grant-tool",
    "/sysadmin/api/revoke-tool",
    "/sysadmin/api/set-role",
    "/sysadmin/api/reset-password",
    "/sysadmin/api/create-user"
  ]);

  if (!ownedPaths.has(rawPath)) {
    return new Response("Not found", { status: 404 });
  }

  // Always send unauthenticated users to the production dashboard for login.
  const dashboardOrigin = "https://splashcarwashes.info";
  const auth = await checkAuth(request);

  if (!auth.authenticated) {
    return Response.redirect(
      `${dashboardOrigin}/?redirect=${encodeURIComponent("/sysadmin")}`,
      302
    );
  }

  if (!auth.isSuperAdmin) {
    return html(403, renderForbidden(auth.user.email));
  }

  // JSON API: per-user detail (called by drawer)
  if (rawPath === "/sysadmin/users/detail") {
    const uid = url.searchParams.get("user_id");
    const eml = url.searchParams.get("email");
    if (!uid) return jsonResp({ error: "user_id required" }, 400);
    try {
      const detail = await fetchUserDetail(uid, eml || "");
      return jsonResp(detail);
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // JSON API: write endpoints (Phase 3)
  if (rawPath.startsWith("/sysadmin/api/")) {
    if (request.method !== "POST") {
      return jsonResp({ error: "POST required" }, 405);
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResp({ error: "Invalid JSON" }, 400);
    }
    try {
      switch (rawPath) {
        case "/sysadmin/api/grant-tool":     return jsonResp(await apiGrantTool(body, auth.user));
        case "/sysadmin/api/revoke-tool":    return jsonResp(await apiRevokeTool(body, auth.user));
        case "/sysadmin/api/set-role":       return jsonResp(await apiSetRole(body, auth.user));
        case "/sysadmin/api/reset-password": return jsonResp(await apiResetPassword(body, auth.user));
        case "/sysadmin/api/create-user":    return jsonResp(await apiCreateUser(body, auth.user));
      }
    } catch (e) {
      console.error("API error on " + rawPath + ":", e);
      return jsonResp({ error: e.message || "Internal error" }, 500);
    }
  }

  // Page renders
  const activeTab = rawPath.endsWith("/locations") ? "locations" : "users";

  if (activeTab === "users") {
    let users = [];
    let loadError = null;
    try {
      users = await fetchUsersForList();
    } catch (e) {
      loadError = e.message;
    }
    return html(200, renderAdminShell(auth.user, "users", { users, loadError }));
  }

  return html(200, renderAdminShell(auth.user, activeTab));
}

/* ===================== AUTH ===================== */

async function checkAuth(request) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const accessToken = cookies["sb-access-token"];

  if (!accessToken) return { authenticated: false };

  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${accessToken}`
    }
  });

  if (!userResponse.ok) return { authenticated: false };

  const user = await userResponse.json();

  // Check super_admin status
  const permResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user.id}&select=role`,
    {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const perms = permResp.ok ? await permResp.json() : [];
  const isSuperAdmin = perms.some(p => p.role === "super_admin");

  return { authenticated: true, user, isSuperAdmin };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach(c => {
    const [name, ...rest] = c.trim().split("=");
    if (name) cookies[name] = rest.join("=");
  });
  return cookies;
}

/* ===================== SUPABASE DATA FETCHERS ===================== */

const SB_HEADERS_SERVICE = () => ({
  "apikey": SUPABASE_SERVICE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json"
});

/**
 * Fetch the list of users for the Users tab.
 *
 * Strategy: fetch user_permissions and user_tool_access (both small public tables),
 * collect distinct user_ids, then fetch those users from auth.admin.users in one call.
 * Build joined rows in JS.
 *
 * Returns: array of { user_id, email, created_at, last_sign_in_at, role, tools[] }
 */
async function fetchUsersForList() {
  // 1) Fetch all user_permissions rows (gives us role + user_id for everyone with a role)
  const permsResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_permissions?select=user_id,role`,
    { headers: SB_HEADERS_SERVICE() }
  );
  if (!permsResp.ok) throw new Error("user_permissions fetch failed: " + permsResp.status);
  const permsRows = await permsResp.json();

  // 2) Fetch all user_tool_access rows
  const toolsResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_tool_access?select=user_id,tool`,
    { headers: SB_HEADERS_SERVICE() }
  );
  if (!toolsResp.ok) throw new Error("user_tool_access fetch failed: " + toolsResp.status);
  const toolsRows = await toolsResp.json();

  // 3) Build per-user maps. Use Map to preserve insertion order and dedupe.
  const userMap = new Map(); // user_id -> { roles: Set, tools: Set }
  const ensure = id => {
    if (!userMap.has(id)) userMap.set(id, { roles: new Set(), tools: new Set() });
    return userMap.get(id);
  };
  for (const r of permsRows) ensure(r.user_id).roles.add(r.role);
  for (const t of toolsRows) ensure(t.user_id).tools.add(t.tool);

  if (userMap.size === 0) return [];

  // 4) Fetch user details from auth.admin (uses service key, bypasses RLS).
  // We can't filter auth.admin.users by id list directly via the API,
  // so fetch a page (default 50 per page, max 1000 in one call with per_page param)
  // and filter in JS. For internal tools with <500 users this is fine.
  const usersResp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`,
    { headers: SB_HEADERS_SERVICE() }
  );
  if (!usersResp.ok) throw new Error("auth admin users fetch failed: " + usersResp.status);
  const usersData = await usersResp.json();
  const allUsers = Array.isArray(usersData) ? usersData : (usersData.users || []);

  // 5) Build the result: only users present in our maps (i.e., have role or tool)
  const result = [];
  for (const u of allUsers) {
    if (!userMap.has(u.id)) continue;
    const meta = userMap.get(u.id);
    result.push({
      user_id: u.id,
      email: u.email || "",
      created_at: u.created_at || null,
      last_sign_in_at: u.last_sign_in_at || null,
      // A user can have multiple user_permissions rows. Pick the highest role.
      // super_admin > location_admin (alphabetically location < super; we want super to win).
      role: meta.roles.has("super_admin") ? "super_admin"
          : (meta.roles.size > 0 ? Array.from(meta.roles)[0] : null),
      tools: Array.from(meta.tools).sort()
    });
  }

  // Sort: super_admins first, then by email
  result.sort((a, b) => {
    if (a.role === "super_admin" && b.role !== "super_admin") return -1;
    if (b.role === "super_admin" && a.role !== "super_admin") return 1;
    return (a.email || "").localeCompare(b.email || "");
  });

  return result;
}

/**
 * For the detail drawer: fetch additional context for a single user.
 * Returns: { perms_rows[], pricing_locations[] }
 *   - perms_rows: full user_permissions rows (includes role + location_code if any)
 *   - pricing_locations: distinct locations from pricing_simple where this user's email
 *     appears in am_email/rm_email/site_email
 */
async function fetchUserDetail(user_id, email) {
  // Full user_permissions rows (could have multiple — one per location)
  const permsResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user_id}&select=role,location_code,must_change_password,created_at`,
    { headers: SB_HEADERS_SERVICE() }
  );
  const perms_rows = permsResp.ok ? await permsResp.json() : [];

  // Tool access with timestamps
  const toolsResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_tool_access?user_id=eq.${user_id}&select=tool,granted_at,notes`,
    { headers: SB_HEADERS_SERVICE() }
  );
  const tools_rows = toolsResp.ok ? await toolsResp.json() : [];

  // Pricing locations matched by email
  let pricing_locations = [];
  if (email) {
    const e = email.toLowerCase();
    const locResp = await fetch(
      `${SUPABASE_URL}/rest/v1/pricing_simple?or=(am_email.eq.${encodeURIComponent(e)},rm_email.eq.${encodeURIComponent(e)},site_email.eq.${encodeURIComponent(e)})&select=location_code,location_pretty,am_email,rm_email,site_email`,
      { headers: SB_HEADERS_SERVICE() }
    );
    if (locResp.ok) {
      const rows = await locResp.json();
      const seen = new Map();
      for (const r of rows) {
        const code = (r.location_code || "").toLowerCase();
        if (code && !seen.has(code)) {
          // Determine which capacity (am/rm/site) this user serves at this location
          const capacities = [];
          if ((r.am_email || "").toLowerCase() === e) capacities.push("AM");
          if ((r.rm_email || "").toLowerCase() === e) capacities.push("RM");
          if ((r.site_email || "").toLowerCase() === e) capacities.push("Site");
          seen.set(code, {
            location_code: code,
            location_pretty: r.location_pretty || code,
            capacities
          });
        }
      }
      pricing_locations = Array.from(seen.values()).sort((a, b) =>
        (a.location_pretty || "").localeCompare(b.location_pretty || "")
      );
    }
  }

  return { perms_rows, tools_rows, pricing_locations };
}

/* ===================== WRITE API HANDLERS (Phase 3) ===================== */

const VALID_TOOLS = new Set(["pricing", "claims", "pertrack"]);
const VALID_ROLES = new Set(["super_admin", "location_admin"]);

async function apiGrantTool({ user_id, tool }, actor) {
  if (!user_id || !tool) throw new Error("user_id and tool required");
  if (!VALID_TOOLS.has(tool)) throw new Error("Invalid tool: " + tool);

  // Idempotent insert: ON CONFLICT DO NOTHING via PostgREST's "Prefer: resolution=merge-duplicates"
  // would require an UPSERT key, which we have (user_id, tool composite PK).
  // PostgREST handles this with ?on_conflict=user_id,tool and Prefer header.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_tool_access?on_conflict=user_id,tool`,
    {
      method: "POST",
      headers: {
        ...SB_HEADERS_SERVICE(),
        "Prefer": "resolution=ignore-duplicates,return=representation"
      },
      body: JSON.stringify({
        user_id,
        tool,
        granted_by: actor.id,
        notes: "Granted via Splash Admin"
      })
    }
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error("Grant failed: " + r.status + " " + errText);
  }
  const inserted = await r.json().catch(() => []);
  const wasNew = Array.isArray(inserted) && inserted.length > 0;

  if (wasNew) {
    await logAudit({
      actor,
      action: "grant_tool",
      target_type: "user_tool_access",
      target_id: user_id + "|" + tool,
      before: null,
      after: inserted[0]
    });
  }
  return { ok: true, was_new: wasNew };
}

async function apiRevokeTool({ user_id, tool }, actor) {
  if (!user_id || !tool) throw new Error("user_id and tool required");
  if (!VALID_TOOLS.has(tool)) throw new Error("Invalid tool: " + tool);

  // Capture the row before delete (for audit log)
  const beforeR = await fetch(
    `${SUPABASE_URL}/rest/v1/user_tool_access?user_id=eq.${user_id}&tool=eq.${tool}&select=*`,
    { headers: SB_HEADERS_SERVICE() }
  );
  const beforeRows = beforeR.ok ? await beforeR.json() : [];
  const before = beforeRows[0] || null;

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_tool_access?user_id=eq.${user_id}&tool=eq.${tool}`,
    { method: "DELETE", headers: SB_HEADERS_SERVICE() }
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error("Revoke failed: " + r.status + " " + errText);
  }

  if (before) {
    await logAudit({
      actor,
      action: "revoke_tool",
      target_type: "user_tool_access",
      target_id: user_id + "|" + tool,
      before,
      after: null
    });
  }
  return { ok: true, was_present: !!before };
}

async function apiSetRole({ user_id, role, location_code }, actor) {
  if (!user_id) throw new Error("user_id required");
  if (role && !VALID_ROLES.has(role)) throw new Error("Invalid role: " + role);

  // Capture before state
  const beforeR = await fetch(
    `${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user_id}&select=*`,
    { headers: SB_HEADERS_SERVICE() }
  );
  const before = beforeR.ok ? await beforeR.json() : [];

  // Look up the user's email — needed because user_permissions.email is NOT NULL
  const userResp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${user_id}`,
    { headers: SB_HEADERS_SERVICE() }
  );
  if (!userResp.ok) throw new Error("Could not look up user email: " + userResp.status);
  const userObj = await userResp.json();
  const userEmail = userObj.email;
  if (!userEmail) throw new Error("User has no email on file");

  if (!role) {
    // Clear all roles
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user_id}`,
      { method: "DELETE", headers: SB_HEADERS_SERVICE() }
    );
    if (!r.ok) throw new Error("Clear role failed: " + r.status);
    await logAudit({
      actor,
      action: "clear_role",
      target_type: "user_permissions",
      target_id: user_id,
      before,
      after: null
    });
    return { ok: true, cleared: true };
  }

  if (role === "super_admin") {
    // Delete all rows, then insert one super_admin row
    await fetch(
      `${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user_id}`,
      { method: "DELETE", headers: SB_HEADERS_SERVICE() }
    );
    const insR = await fetch(
      `${SUPABASE_URL}/rest/v1/user_permissions`,
      {
        method: "POST",
        headers: { ...SB_HEADERS_SERVICE(), "Prefer": "return=representation" },
        body: JSON.stringify({
          user_id,
          email: userEmail,
          role: "super_admin",
          must_change_password: false
        })
      }
    );
    if (!insR.ok) {
      const errText = await insR.text().catch(() => "");
      throw new Error("Set super_admin failed: " + insR.status + " " + errText);
    }
    const after = await insR.json();
    await logAudit({
      actor,
      action: "set_role_super_admin",
      target_type: "user_permissions",
      target_id: user_id,
      before,
      after
    });
    return { ok: true, after };
  }

  // role === "location_admin"
  await fetch(
    `${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user_id}`,
    { method: "DELETE", headers: SB_HEADERS_SERVICE() }
  );
  const insR2 = await fetch(
    `${SUPABASE_URL}/rest/v1/user_permissions`,
    {
      method: "POST",
      headers: { ...SB_HEADERS_SERVICE(), "Prefer": "return=representation" },
      body: JSON.stringify({
        user_id,
        email: userEmail,
        role: "location_admin",
        location_code: location_code || null,
        must_change_password: false
      })
    }
  );
  if (!insR2.ok) {
    const errText = await insR2.text().catch(() => "");
    throw new Error("Set location_admin failed: " + insR2.status + " " + errText);
  }
  const after2 = await insR2.json();
  await logAudit({
    actor,
    action: "set_role_location_admin",
    target_type: "user_permissions",
    target_id: user_id,
    before,
    after: after2
  });
  return { ok: true, after: after2 };
}

async function apiResetPassword({ user_id, new_password }, actor) {
  if (!user_id || !new_password) throw new Error("user_id and new_password required");
  if (new_password.length < 8) throw new Error("Password must be at least 8 characters");

  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${user_id}`,
    {
      method: "PUT",
      headers: SB_HEADERS_SERVICE(),
      body: JSON.stringify({ password: new_password })
    }
  );
  if (!r.ok) {
    const errData = await r.json().catch(() => ({}));
    throw new Error(errData.msg || errData.message || "Password reset failed: " + r.status);
  }

  await logAudit({
    actor,
    action: "reset_password",
    target_type: "auth.users",
    target_id: user_id,
    before: null,
    after: null,
    notes: "Password reset by super_admin"
  });
  return { ok: true };
}

async function apiCreateUser({ email, password, role, tools }, actor) {
  if (!email || !password) throw new Error("email and password required");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  if (role && !VALID_ROLES.has(role)) throw new Error("Invalid role: " + role);

  const cleanTools = Array.isArray(tools) ? tools.filter(t => VALID_TOOLS.has(t)) : [];

  // 1) Create the auth user
  const createR = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users`,
    {
      method: "POST",
      headers: SB_HEADERS_SERVICE(),
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        password,
        email_confirm: true
      })
    }
  );
  if (!createR.ok) {
    const errData = await createR.json().catch(() => ({}));
    throw new Error(errData.msg || errData.message || "Create user failed: " + createR.status);
  }
  const created = await createR.json();
  const newUserId = created.id;

  // 2) Insert user_permissions row if role specified
  if (role) {
    const insR = await fetch(
      `${SUPABASE_URL}/rest/v1/user_permissions`,
      {
        method: "POST",
        headers: { ...SB_HEADERS_SERVICE(), "Prefer": "return=minimal" },
        body: JSON.stringify({
          user_id: newUserId,
          email: email.trim().toLowerCase(),
          role,
          must_change_password: false
        })
      }
    );
    if (!insR.ok) {
      const errText = await insR.text().catch(() => "");
      throw new Error("Create user_permissions failed: " + insR.status + " " + errText);
    }
  }

  // 3) Insert tool grants
  if (cleanTools.length > 0) {
    const toolRows = cleanTools.map(t => ({
      user_id: newUserId,
      tool: t,
      granted_by: actor.id,
      notes: "Initial grant on user creation"
    }));
    await fetch(
      `${SUPABASE_URL}/rest/v1/user_tool_access`,
      {
        method: "POST",
        headers: { ...SB_HEADERS_SERVICE(), "Prefer": "return=minimal" },
        body: JSON.stringify(toolRows)
      }
    );
  }

  await logAudit({
    actor,
    action: "create_user",
    target_type: "auth.users",
    target_id: newUserId,
    before: null,
    after: { email, role: role || null, tools: cleanTools }
  });

  return { ok: true, user_id: newUserId, email };
}

/* ===================== AUDIT LOG (used in later phases) ===================== */

// eslint-disable-next-line no-unused-vars
async function logAudit({ actor, action, target_type, target_id, before, after, notes }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sysadmin_audit_log`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        actor_id: actor?.id || null,
        actor_email: actor?.email || "system",
        action,
        target_type,
        target_id: target_id != null ? String(target_id) : null,
        before: before || null,
        after: after || null,
        notes: notes || null
      })
    });
  } catch (e) {
    console.error("logAudit failed:", e);
  }
}

/* ===================== HELPERS ===================== */

function html(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===================== RENDER ===================== */

const BRAND_STYLES = `
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --sudsy-blue-soft: #d6f1fb;
    --splash-navy: #1c164e;
    --cream: #f5eedd;
    --yellow: #f1c61e;
    --racecar-red: #dc3e26;
    --ok: #067647;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --border: #e3e6eb;
    --border-strong: #d0d4dc;
    --muted: #6b7280;
    --white: #ffffff;
    --radius-sm: 6px;
    --radius-md: 10px;
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
  }
`;

const FONT_LINK = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
`;

function renderForbidden(email) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<title>Access Denied — Splash Admin</title>
<link rel="icon" type="image/png" href="${ASSETS.favicon}"/>
${FONT_LINK}
<style>
  ${BRAND_STYLES}
  body { display: flex; align-items: center; justify-content: center; padding: 20px; }
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
  .card-body .email { font-weight: 700; }
  .card-body .muted { color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; }
  .btn {
    padding: 10px 20px; height: 42px;
    font: 700 14px var(--font-body);
    border-radius: var(--radius-sm); cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .btn-primary {
    background: var(--splash-blue); color: #fff; border: none;
    box-shadow: var(--shadow-btn);
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <img src="${ASSETS.logoWhite}" alt="Splash Car Washes"/>
      <div class="eyebrow">Splash Admin</div>
      <h1>Access Denied</h1>
    </div>
    <div class="card-body">
      <p>Sorry, <span class="email">${esc(email || "this account")}</span> doesn't have super-admin access.</p>
      <p class="muted">Splash Admin is restricted to super administrators.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/">Return to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderAdminShell(user, activeTab = "users", data = {}) {
  const tabUsersClass = activeTab === "users" ? "active" : "";
  const tabLocsClass  = activeTab === "locations" ? "active" : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<title>Splash Admin</title>
<link rel="icon" type="image/png" href="${ASSETS.favicon}"/>
${FONT_LINK}
<style>
  ${BRAND_STYLES}

  /* ========== TOPBAR (matches Damage Claims sizing) ========== */
  header.topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 32px;
    flex-wrap: wrap;
    gap: 16px;
    color: #fff;
  }
  header.topbar .topbar-left {
    display: flex; align-items: center; gap: 18px;
    flex-wrap: wrap;
  }
  header.topbar .brand {
    display: flex; align-items: center; gap: 18px;
    text-decoration: none; color: inherit;
    transition: opacity 0.15s ease;
  }
  header.topbar .brand:hover { opacity: 0.85; }
  header.topbar .brand img { height: 56px; width: auto; object-fit: contain; flex-shrink: 0; }
  header.topbar .brand-text { display: flex; flex-direction: column; gap: 2px; }
  header.topbar .brand-text .eyebrow {
    font-size: 0.75rem; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--sudsy-blue);
  }
  header.topbar .brand-text .title {
    font-size: 1.375rem; font-weight: 700;
    color: #fff; line-height: 1.2; margin: 0;
  }
  header.topbar .nav-back {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 18px;
    font: 700 0.875rem var(--font-body);
    color: #fff; background: transparent;
    border: 1.5px solid rgba(255,255,255,0.5);
    border-radius: var(--radius-sm);
    text-decoration: none; cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  header.topbar .nav-back:hover {
    background: rgba(255,255,255,0.1);
    border-color: var(--white);
  }
  header.topbar .nav-back svg { width: 14px; height: 14px; flex-shrink: 0; }

  header.topbar .who {
    display: flex; align-items: center; gap: 16px;
    flex-wrap: wrap;
  }
  header.topbar .who .email { color: rgba(255,255,255,0.85); font-size: 0.875rem; }
  header.topbar .who a {
    padding: 8px 18px;
    font: 700 0.875rem var(--font-body);
    color: #fff; background: transparent;
    border: 1.5px solid rgba(255,255,255,0.5);
    border-radius: var(--radius-sm);
    text-decoration: none;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  header.topbar .who a:hover {
    background: rgba(255,255,255,0.1);
    border-color: var(--white);
  }

  /* ========== TAB STRIP ========== */
  main { max-width: 1200px; margin: 8px auto 48px; padding: 0 28px; }
  .tabs {
    display: flex; gap: 8px;
    margin-bottom: 18px;
    flex-wrap: wrap;
  }
  .tab {
    padding: 10px 20px;
    font: 700 0.875rem var(--font-body);
    color: rgba(255,255,255,0.7);
    background: transparent;
    border: 1.5px solid rgba(255,255,255,0.3);
    border-radius: var(--radius-sm);
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  .tab:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.6);
    color: #fff;
  }
  .tab.active {
    background: var(--splash-blue);
    border-color: var(--splash-blue);
    color: #fff;
    box-shadow: var(--shadow-btn);
  }

  /* ========== CARDS ========== */
  .card {
    background: var(--panel);
    border-radius: var(--radius-lg);
    padding: 24px 28px;
    box-shadow: var(--shadow-card);
    color: var(--splash-navy);
  }

  h2.section-h {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--sudsy-blue);
    margin: 0 0 12px;
  }
  .card h1 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 700;
    color: var(--splash-navy);
    letter-spacing: -0.005em;
  }
  .card p {
    margin: 0;
    font-size: 14px;
    color: var(--muted);
    line-height: 1.5;
  }
  .placeholder {
    text-align: center;
    padding: 32px 16px;
    color: var(--muted);
    border: 1.5px dashed var(--border);
    border-radius: var(--radius-md);
    margin-top: 16px;
    font-size: 14px;
  }

  /* ========== USERS TAB ========== */
  .toolbar {
    display: flex; align-items: center; gap: 12px;
    margin: 14px 0 16px;
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1; min-width: 220px; max-width: 480px;
    height: 40px; padding: 8px 14px;
    font: 14px var(--font-body); color: var(--splash-navy);
    background: #fff;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search-input:focus {
    outline: none; border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }
  .toolbar .count {
    margin-left: auto;
    font-size: 13px; color: var(--muted);
  }

  .table-card { padding: 0; overflow: hidden; }
  .table-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    width: 100%;
  }
  table.users-table {
    width: 100%;
    min-width: 760px;
    border-collapse: collapse;
    font-size: 13px;
  }
  .users-table thead th {
    text-align: left;
    padding: 14px 16px;
    color: var(--sudsy-blue);
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    background: var(--splash-navy);
    white-space: nowrap;
  }
  .users-table tbody td {
    padding: 13px 16px;
    border-bottom: 1px solid #eef0f4;
    color: var(--splash-navy);
    vertical-align: middle;
  }
  .users-table tbody tr {
    transition: background 0.1s ease;
    cursor: pointer;
  }
  .users-table tbody tr:hover { background: var(--sudsy-blue-soft); }
  .users-table tbody tr:last-child td { border-bottom: none; }
  .users-table .email-cell { font-weight: 600; }
  .users-table .muted { color: var(--muted); font-size: 12px; }

  .role-pill, .tool-pill {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .role-pill.super { background: #fee2e2; color: #991b1b; }
  .role-pill.loc   { background: #dbeafe; color: #1d4ed8; }
  .role-pill.none  { background: #f3f4f6; color: var(--muted); }

  .tools-cell { display: flex; gap: 4px; flex-wrap: wrap; }
  .tool-pill.pricing  { background: var(--sudsy-blue-soft); color: var(--splash-blue-dark); }
  .tool-pill.claims   { background: #fef3c7; color: #92400e; }
  .tool-pill.pertrack { background: #ede9fe; color: #5b21b6; }
  .tool-pill.none     { background: #fee2e2; color: #991b1b; }

  .empty-state {
    text-align: center; padding: 48px 20px;
    color: var(--muted); font-size: 14px;
  }
  .err-state {
    padding: 16px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: var(--radius-sm);
    color: var(--racecar-red);
    font-size: 13px;
    margin-top: 12px;
  }

  /* ========== DRAWER ========== */
  .drawer-backdrop {
    position: fixed; inset: 0;
    background: rgba(28, 22, 78, 0.55);
    backdrop-filter: blur(2px);
    z-index: 20;
    display: none;
  }
  .drawer-backdrop.open { display: block; }
  .drawer {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 540px; max-width: 100vw;
    background: #fff;
    z-index: 21;
    transform: translateX(100%);
    transition: transform 0.22s ease;
    overflow-y: auto;
    box-shadow: -8px 0 30px rgba(0,0,0,0.2);
    display: flex; flex-direction: column;
  }
  .drawer.open { transform: translateX(0); }
  .drawer-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 12px;
    padding: 22px 26px 16px;
    border-bottom: 1px solid var(--border);
    background: #fff;
    position: sticky; top: 0; z-index: 1;
  }
  .drawer-header .eyebrow {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .drawer-header h3 {
    margin: 0; font-size: 17px;
    font-weight: 700; color: var(--splash-navy);
    word-break: break-all;
  }
  .drawer-close {
    background: transparent; border: 1.5px solid var(--border-strong);
    padding: 6px 14px; border-radius: var(--radius-sm);
    font: 600 13px var(--font-body); color: var(--splash-navy);
    cursor: pointer; flex-shrink: 0;
  }
  .drawer-close:hover { background: #f3f4f6; border-color: var(--splash-navy); }

  .drawer-body { padding: 18px 26px 28px; flex: 1; }
  .drawer-section { margin-bottom: 22px; }
  .drawer-section h4 {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--sudsy-blue);
    margin: 0 0 10px;
  }
  .drawer dl {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 8px 16px;
    margin: 0;
    font-size: 13px;
  }
  .drawer dt { color: var(--muted); font-weight: 600; }
  .drawer dd { margin: 0; color: var(--splash-navy); word-break: break-word; }
  .drawer dd code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--splash-blue); }
  .drawer-list {
    margin: 0; padding: 0; list-style: none;
    display: flex; flex-direction: column; gap: 6px;
  }
  .drawer-list li {
    padding: 10px 12px;
    background: #f8f9fb;
    border-radius: var(--radius-sm);
    font-size: 13px; color: var(--splash-navy);
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px;
  }
  .drawer-list li .meta { color: var(--muted); font-size: 11px; font-weight: 600; }
  .drawer-loading { padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }

  /* ========== PHASE 3: drawer interactive controls ========== */
  .manage-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 16px;
    padding: 10px 12px;
    background: #f8f9fb;
    border-radius: var(--radius-sm);
    margin-bottom: 6px;
  }
  .manage-row .label {
    font-size: 13px; font-weight: 600; color: var(--splash-navy);
    display: flex; align-items: center; gap: 8px;
  }
  .manage-row .desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .manage-row .label-stack { display: flex; flex-direction: column; }

  /* Toggle switch (re-uses tool-pill colors) */
  .switch {
    position: relative; display: inline-block;
    width: 42px; height: 24px;
    flex-shrink: 0;
  }
  .switch input {
    opacity: 0; width: 0; height: 0;
    margin: 0; padding: 0;
  }
  .switch .slider {
    position: absolute; cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: #d1d5db;
    border-radius: 999px;
    transition: background 0.15s ease;
  }
  .switch .slider::before {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 20px; height: 20px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.15s ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }
  .switch input:checked + .slider { background: var(--splash-blue); }
  .switch input:checked + .slider::before { transform: translateX(18px); }
  .switch input:disabled + .slider { opacity: 0.5; cursor: not-allowed; }

  /* Role select */
  .role-select {
    height: 36px; padding: 6px 10px;
    font: 600 13px var(--font-body); color: var(--splash-navy);
    background: #fff;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    min-width: 160px;
  }
  .role-select:focus {
    outline: none; border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }

  /* Compact action buttons inside drawer */
  .btn {
    padding: 8px 16px; height: 36px;
    font: 700 13px var(--font-body);
    border-radius: var(--radius-sm);
    cursor: pointer; border: none;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
  }
  .btn-primary {
    background: var(--splash-blue); color: #fff;
    box-shadow: var(--shadow-btn);
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
  .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; }
  .btn-ghost {
    background: transparent; color: var(--splash-navy);
    border: 1.5px solid var(--border-strong);
  }
  .btn-ghost:hover { background: #f3f4f6; border-color: var(--splash-navy); }
  .btn-danger {
    background: var(--racecar-red); color: #fff;
  }
  .btn-danger:hover { background: #b8341f; }
  .btn-block { width: 100%; }
  .btn-sm { height: 32px; padding: 6px 12px; font-size: 12px; }

  /* Top-of-page action bar (Create User button) */
  .top-actions {
    display: flex; gap: 10px; flex-wrap: wrap;
    margin-top: 8px;
  }

  /* ========== MODAL ========== */
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(28, 22, 78, 0.72);
    backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center;
    z-index: 9999; padding: 20px;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: #fff;
    border-radius: var(--radius-lg);
    width: 100%; max-width: 440px;
    max-height: 88vh; overflow: hidden;
    box-shadow: 0 20px 60px rgba(28, 22, 78, 0.5);
    display: flex; flex-direction: column;
  }
  .modal-head {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: #fff;
    padding: 18px 24px;
    flex-shrink: 0;
  }
  .modal-head .eyebrow {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .modal-head h3 {
    margin: 0; font-size: 17px; font-weight: 700; color: #fff;
  }
  .modal-body {
    padding: 18px 24px;
    overflow-y: auto;
    flex: 1;
  }
  .modal-body .field { margin-bottom: 12px; }
  .modal-body label {
    display: block; font-size: 12px; font-weight: 600;
    color: var(--splash-navy); margin-bottom: 4px;
  }
  .modal-body input[type="text"],
  .modal-body input[type="email"],
  .modal-body input[type="password"],
  .modal-body select {
    width: 100%; height: 40px; padding: 8px 12px;
    font: 14px var(--font-body); color: var(--splash-navy);
    background: #fff;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .modal-body input:focus, .modal-body select:focus {
    outline: none; border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }
  .modal-body .input-with-button {
    display: flex; gap: 6px;
  }
  .modal-body .input-with-button input { flex: 1; }
  .modal-body .helper {
    font-size: 11px; color: var(--muted);
    margin-top: 4px;
  }
  .modal-body .checkbox-group {
    display: flex; flex-direction: column; gap: 6px;
  }
  .modal-body .checkbox-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    background: #f8f9fb;
    border-radius: var(--radius-sm);
    font-size: 13px; color: var(--splash-navy);
    cursor: pointer;
  }
  .modal-body .checkbox-row:hover { background: var(--sudsy-blue-soft); }
  .modal-body .checkbox-row input[type="checkbox"] {
    width: 16px; height: 16px; margin: 0; cursor: pointer;
  }
  .modal-actions {
    display: flex; justify-content: flex-end; gap: 10px;
    padding: 14px 24px 20px;
    background: #fff;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .modal-error {
    margin-top: 10px;
    padding: 10px 12px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: var(--racecar-red);
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
  }
  .modal-success {
    margin-top: 10px;
    padding: 10px 12px;
    background: #ecfdf3;
    border: 1px solid #b7e9c8;
    color: var(--ok);
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
  }

  /* ========== TOAST ========== */
  .toast {
    position: fixed;
    bottom: 24px; right: 24px;
    padding: 12px 20px;
    border-radius: var(--radius-sm);
    color: #fff;
    font: 600 13px var(--font-body);
    z-index: 30;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
    animation: toast-in 0.22s ease;
    max-width: 360px;
  }
  .toast.ok  { background: var(--ok); }
  .toast.err { background: var(--racecar-red); }
  @keyframes toast-in {
    from { transform: translateY(12px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <a class="brand" href="/" title="Return to dashboard">
        <img src="${ASSETS.logoWhite}" alt="Splash Car Washes"/>
        <div class="brand-text">
          <span class="eyebrow">Internal Tools</span>
          <span class="title">Splash Admin</span>
        </div>
      </a>
      <a class="nav-back" href="/" title="Return to dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        Dashboard
      </a>
    </div>
    <div class="who">
      <span class="email">${esc(user.email || "")}</span>
      <a href="/logout">Sign Out</a>
    </div>
  </header>

  <main>
    <div class="tabs">
      <a class="tab ${tabUsersClass}" href="/sysadmin/users">Users &amp; Permissions</a>
      <a class="tab ${tabLocsClass}" href="/sysadmin/locations">Locations</a>
    </div>

    ${activeTab === "users" ? renderUsers(data) : renderLocationsPlaceholder()}
  </main>

  ${activeTab === "users" ? renderDrawerShell() : ""}
</body>
</html>`;
}

function renderUsers(data) {
  const { users = [], loadError = null } = data || {};

  if (loadError) {
    return `
      <div class="card">
        <h2 class="section-h">Users &amp; Permissions</h2>
        <h1>Manage user access</h1>
        <div class="err-state">Failed to load users: ${esc(loadError)}</div>
      </div>`;
  }

  const rows = users.map(u => {
    const roleClass = u.role === "super_admin" ? "super"
      : (u.role === "location_admin" ? "loc" : "none");
    const roleLabel = u.role === "super_admin" ? "Super"
      : (u.role === "location_admin" ? "Location" : "None");

    const toolPills = u.tools.length === 0
      ? `<span class="tool-pill none">No tools</span>`
      : u.tools.map(t => `<span class="tool-pill ${esc(t)}">${esc(t)}</span>`).join("");

    const lastSeen = u.last_sign_in_at
      ? new Date(u.last_sign_in_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      : '<span class="muted">Never</span>';

    const created = u.created_at
      ? new Date(u.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      : "—";

    return `<tr data-user-id="${esc(u.user_id)}" data-email="${esc(u.email)}">
      <td class="email-cell">${esc(u.email || "(no email)")}</td>
      <td><span class="role-pill ${roleClass}">${roleLabel}</span></td>
      <td class="tools-cell">${toolPills}</td>
      <td>${lastSeen}</td>
      <td><span class="muted">${created}</span></td>
    </tr>`;
  }).join("");

  return `
    <div class="card">
      <h2 class="section-h">Users &amp; Permissions</h2>
      <h1>Manage user access</h1>
      <p>View all users with assigned roles or tool access. Click any row for details. Toggle tool access, change roles, reset passwords \u2014 all in the drawer.</p>

      <div class="top-actions">
        <button type="button" class="btn btn-primary" id="newUserBtn">+ Create User</button>
      </div>

      <div class="toolbar">
        <input type="text" class="search-input" id="userSearch" placeholder="Search by email..." autocomplete="off"/>
        <span class="count" id="userCount">${users.length} user${users.length === 1 ? "" : "s"}</span>
      </div>
    </div>

    <div class="card table-card" style="margin-top: 16px;">
      <div class="table-scroll">
        <table class="users-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Tools</th>
              <th>Last Sign-in</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="userTbody">
            ${rows || `<tr><td colspan="5" class="empty-state">No users to display.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <script>
    (function() {
      const search = document.getElementById('userSearch');
      const count  = document.getElementById('userCount');
      const tbody  = document.getElementById('userTbody');
      if (!search || !tbody) return;

      const allRows = Array.from(tbody.querySelectorAll('tr[data-user-id]'));

      function updateCount(visible) {
        count.textContent = visible + ' of ' + allRows.length + (allRows.length === 1 ? ' user' : ' users');
      }
      updateCount(allRows.length);

      search.addEventListener('input', function() {
        const q = (this.value || '').toLowerCase().trim();
        let visible = 0;
        allRows.forEach(tr => {
          const email = (tr.getAttribute('data-email') || '').toLowerCase();
          const match = !q || email.includes(q);
          tr.style.display = match ? '' : 'none';
          if (match) visible++;
        });
        updateCount(visible);
      });

      // Click row -> open drawer
      allRows.forEach(tr => {
        tr.addEventListener('click', () => openUserDrawer(
          tr.getAttribute('data-user-id'),
          tr.getAttribute('data-email')
        ));
      });
    })();
    </script>`;
}

function renderDrawerShell() {
  return `
    <div class="drawer-backdrop" id="drawerBackdrop"></div>
    <aside class="drawer" id="userDrawer" aria-hidden="true">
      <div class="drawer-header">
        <div>
          <div class="eyebrow">User Detail</div>
          <h3 id="drawerEmail">\u2014</h3>
        </div>
        <button class="drawer-close" id="drawerCloseBtn" type="button">Close</button>
      </div>
      <div class="drawer-body" id="drawerBody">
        <div class="drawer-loading">Loading...</div>
      </div>
    </aside>

    <!-- Create User modal -->
    <div class="modal-overlay" id="createUserOverlay">
      <div class="modal">
        <div class="modal-head">
          <div class="eyebrow">Splash Admin</div>
          <h3>Create new user</h3>
        </div>
        <div class="modal-body">
          <div class="field">
            <label for="cuEmail">Email <span style="color:var(--racecar-red);">*</span></label>
            <input type="email" id="cuEmail" placeholder="firstname.lastname@splashcarwashes.com" autocomplete="off"/>
          </div>
          <div class="field">
            <label for="cuPassword">Initial password <span style="color:var(--racecar-red);">*</span></label>
            <div class="input-with-button">
              <input type="text" id="cuPassword" placeholder="Type or generate"/>
              <button type="button" class="btn btn-ghost btn-sm" id="cuGenBtn">Generate</button>
            </div>
            <div class="helper">Min 8 characters. User can change after first login.</div>
          </div>
          <div class="field">
            <label for="cuRole">Role</label>
            <select id="cuRole">
              <option value="">No role (tools only)</option>
              <option value="location_admin">location_admin</option>
              <option value="super_admin">super_admin</option>
            </select>
          </div>
          <div class="field">
            <label>Tool access</label>
            <div class="checkbox-group">
              <label class="checkbox-row"><input type="checkbox" value="pricing"  class="cu-tool"/> Pricing Admin</label>
              <label class="checkbox-row"><input type="checkbox" value="claims"   class="cu-tool"/> Damage Claims</label>
              <label class="checkbox-row"><input type="checkbox" value="pertrack" class="cu-tool"/> Performance Tracker</label>
            </div>
          </div>
          <div id="cuMessage"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cuCancelBtn">Cancel</button>
          <button type="button" class="btn btn-primary" id="cuSaveBtn">Create user</button>
        </div>
      </div>
    </div>

    <!-- Password Reset modal -->
    <div class="modal-overlay" id="resetPwOverlay">
      <div class="modal">
        <div class="modal-head">
          <div class="eyebrow">Splash Admin</div>
          <h3 id="rpHead">Reset password</h3>
        </div>
        <div class="modal-body">
          <p style="margin:0 0 12px;font-size:13px;color:var(--muted);">
            Setting a new password for <strong id="rpEmail" style="color:var(--splash-navy);"></strong>.
            They'll need to use the new password on their next sign-in.
          </p>
          <div class="field">
            <label for="rpPassword">New password <span style="color:var(--racecar-red);">*</span></label>
            <div class="input-with-button">
              <input type="text" id="rpPassword" placeholder="Type or generate"/>
              <button type="button" class="btn btn-ghost btn-sm" id="rpGenBtn">Generate</button>
            </div>
            <div class="helper">Min 8 characters. Copy this and share with the user securely.</div>
          </div>
          <div id="rpMessage"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="rpCancelBtn">Cancel</button>
          <button type="button" class="btn btn-primary" id="rpSaveBtn">Reset password</button>
        </div>
      </div>
    </div>

    <!-- Confirm modal (used for destructive actions) -->
    <div class="modal-overlay" id="confirmOverlay">
      <div class="modal" style="max-width:400px;">
        <div class="modal-head" style="background:linear-gradient(135deg,#dc3e26 0%,#a02a18 100%);">
          <div class="eyebrow">Confirm</div>
          <h3 id="confirmTitle">Are you sure?</h3>
        </div>
        <div class="modal-body">
          <p id="confirmText" style="margin:0;font-size:14px;color:var(--splash-navy);"></p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="confirmCancelBtn">Cancel</button>
          <button type="button" class="btn btn-danger" id="confirmOkBtn">Confirm</button>
        </div>
      </div>
    </div>

    <script>
    (function() {
      const drawer       = document.getElementById('userDrawer');
      const backdrop     = document.getElementById('drawerBackdrop');
      const closeBtn     = document.getElementById('drawerCloseBtn');
      const emailEl      = document.getElementById('drawerEmail');
      const bodyEl       = document.getElementById('drawerBody');

      // Modals
      const cuOverlay    = document.getElementById('createUserOverlay');
      const rpOverlay    = document.getElementById('resetPwOverlay');
      const confirmOverlay = document.getElementById('confirmOverlay');

      // Track currently open user
      let currentUser = { id: null, email: null };

      /* ============ helpers ============ */

      function escHtml(s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      }
      function fmtDate(iso) {
        if (!iso) return "\u2014";
        return new Date(iso).toLocaleString(undefined, {
          year: "numeric", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit"
        });
      }
      function toast(msg, kind) {
        const el = document.createElement("div");
        el.className = "toast " + (kind || "ok");
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3500);
      }
      function genPassword(len) {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*";
        let out = "";
        const arr = new Uint32Array(len || 14);
        crypto.getRandomValues(arr);
        for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
        return out;
      }
      function confirmDialog(title, text) {
        return new Promise(resolve => {
          document.getElementById('confirmTitle').textContent = title;
          document.getElementById('confirmText').textContent = text;
          confirmOverlay.classList.add('open');
          const ok = document.getElementById('confirmOkBtn');
          const cancel = document.getElementById('confirmCancelBtn');
          function done(value) {
            confirmOverlay.classList.remove('open');
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            resolve(value);
          }
          function onOk() { done(true); }
          function onCancel() { done(false); }
          ok.addEventListener('click', onOk);
          cancel.addEventListener('click', onCancel);
        });
      }

      async function postJSON(url, body) {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
        return data;
      }

      /* ============ drawer open/close ============ */

      function closeDrawer() {
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
      }
      closeBtn.addEventListener('click', closeDrawer);
      backdrop.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          closeDrawer();
          cuOverlay.classList.remove('open');
          rpOverlay.classList.remove('open');
          confirmOverlay.classList.remove('open');
        }
      });

      window.openUserDrawer = async function(userId, email) {
        currentUser = { id: userId, email };
        emailEl.textContent = email || "(no email)";
        bodyEl.innerHTML = '<div class="drawer-loading">Loading...</div>';
        drawer.classList.add('open');
        backdrop.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        await refreshDrawer();
      };

      async function refreshDrawer() {
        try {
          const r = await fetch('/sysadmin/users/detail?user_id=' +
            encodeURIComponent(currentUser.id) +
            '&email=' + encodeURIComponent(currentUser.email || ''));
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          bodyEl.innerHTML = renderDetail(currentUser.id, currentUser.email, data);
          wireDrawerControls(data);
        } catch (err) {
          bodyEl.innerHTML = '<div class="err-state">Failed to load: ' + escHtml(err.message) + '</div>';
        }
      }

      function renderDetail(userId, email, data) {
        const perms = data.perms_rows || [];
        const tools = data.tools_rows || [];
        const locs  = data.pricing_locations || [];

        const grantedTools = new Set(tools.map(t => t.tool));
        const currentRole = perms.length === 0 ? ""
          : (perms.some(p => p.role === "super_admin") ? "super_admin" : "location_admin");

        // Identity
        let html = '<div class="drawer-section"><h4>Identity</h4><dl>' +
          '<dt>Email</dt><dd>' + escHtml(email || "\u2014") + '</dd>' +
          '<dt>User ID</dt><dd><code>' + escHtml(userId) + '</code></dd>' +
          '</dl></div>';

        // ===== MANAGE: tool toggles =====
        html += '<div class="drawer-section"><h4>Tool access</h4>';
        ['pricing', 'claims', 'pertrack'].forEach(tool => {
          const on = grantedTools.has(tool);
          const label = tool === 'pricing' ? 'Pricing Admin'
                      : tool === 'claims' ? 'Damage Claims'
                      : 'Performance Tracker';
          html += '<div class="manage-row">' +
            '<div class="label-stack">' +
              '<span class="label">' + label + '</span>' +
              '<span class="desc">' + tool + '</span>' +
            '</div>' +
            '<label class="switch">' +
              '<input type="checkbox" class="tool-toggle" data-tool="' + tool + '"' + (on ? ' checked' : '') + '>' +
              '<span class="slider"></span>' +
            '</label>' +
          '</div>';
        });
        html += '</div>';

        // ===== MANAGE: role =====
        html += '<div class="drawer-section"><h4>Role</h4>' +
          '<div class="manage-row">' +
            '<div class="label-stack">' +
              '<span class="label">Primary role</span>' +
              '<span class="desc">Controls what they see in tools that gate by role.</span>' +
            '</div>' +
            '<select class="role-select" id="roleSelect">' +
              '<option value=""' + (currentRole === '' ? ' selected' : '') + '>No role</option>' +
              '<option value="location_admin"' + (currentRole === 'location_admin' ? ' selected' : '') + '>location_admin</option>' +
              '<option value="super_admin"' + (currentRole === 'super_admin' ? ' selected' : '') + '>super_admin</option>' +
            '</select>' +
          '</div>' +
        '</div>';

        // Existing role assignments (read-only, with location_code if any)
        if (perms.length > 0) {
          html += '<div class="drawer-section"><h4>Role assignments (raw rows)</h4><ul class="drawer-list">';
          perms.forEach(p => {
            const loc = p.location_code ? ' \u00b7 ' + escHtml(p.location_code) : '';
            const mcp = p.must_change_password ? ' (must change password)' : '';
            html += '<li><span><strong>' + escHtml(p.role) + '</strong>' + loc + mcp + '</span><span class="meta">' + fmtDate(p.created_at) + '</span></li>';
          });
          html += '</ul></div>';
        }

        // Pricing locations
        if (locs.length > 0) {
          html += '<div class="drawer-section"><h4>Pricing access (locations)</h4><ul class="drawer-list">';
          locs.forEach(l => {
            const cap = l.capacities && l.capacities.length ? l.capacities.join(", ") : "";
            html += '<li><span><strong>' + escHtml(l.location_pretty) + '</strong> \u00b7 <code>' + escHtml(l.location_code) + '</code></span><span class="meta">' + escHtml(cap) + '</span></li>';
          });
          html += '</ul></div>';
        }

        // Password reset
        html += '<div class="drawer-section"><h4>Password</h4>' +
          '<button type="button" class="btn btn-ghost btn-block" id="resetPwBtn">Reset password</button>' +
          '</div>';

        return html;
      }

      function wireDrawerControls(data) {
        const grantedTools = new Set((data.tools_rows || []).map(t => t.tool));

        // Tool toggles
        bodyEl.querySelectorAll('.tool-toggle').forEach(input => {
          input.addEventListener('change', async () => {
            const tool = input.getAttribute('data-tool');
            const turningOn = input.checked;

            // Confirm super-admin tools? (per your direction: confirm role changes only,
            // not routine tool toggles)
            input.disabled = true;
            try {
              if (turningOn) {
                await postJSON('/sysadmin/api/grant-tool', { user_id: currentUser.id, tool });
                toast('Granted ' + tool + ' to ' + currentUser.email, 'ok');
              } else {
                await postJSON('/sysadmin/api/revoke-tool', { user_id: currentUser.id, tool });
                toast('Revoked ' + tool + ' from ' + currentUser.email, 'ok');
              }
              await refreshDrawer();
            } catch (err) {
              toast(err.message, 'err');
              input.checked = !turningOn; // revert
              input.disabled = false;
            }
          });
        });

        // Role select
        const roleSel = bodyEl.querySelector('#roleSelect');
        if (roleSel) {
          const originalRole = roleSel.value;
          roleSel.addEventListener('change', async () => {
            const newRole = roleSel.value;
            if (newRole === originalRole) return;

            // Confirm only when SETTING super_admin or REMOVING super_admin
            const becomingSuper = newRole === 'super_admin';
            const losingSuper   = originalRole === 'super_admin' && newRole !== 'super_admin';
            if (becomingSuper || losingSuper) {
              const confirmed = await confirmDialog(
                becomingSuper ? 'Grant super_admin role?' : 'Remove super_admin role?',
                becomingSuper
                  ? 'super_admin gives full access to all tools, all locations, and the Splash Admin tool itself. Continue?'
                  : 'This user will lose super_admin access immediately. They may lose access to tools that depend on it. Continue?'
              );
              if (!confirmed) {
                roleSel.value = originalRole;
                return;
              }
            }

            roleSel.disabled = true;
            try {
              await postJSON('/sysadmin/api/set-role', {
                user_id: currentUser.id,
                role: newRole || null
              });
              toast('Role updated to ' + (newRole || 'none'), 'ok');
              await refreshDrawer();
            } catch (err) {
              toast(err.message, 'err');
              roleSel.value = originalRole;
              roleSel.disabled = false;
            }
          });
        }

        // Reset password button
        const rpBtn = bodyEl.querySelector('#resetPwBtn');
        if (rpBtn) {
          rpBtn.addEventListener('click', () => {
            document.getElementById('rpEmail').textContent = currentUser.email || '';
            document.getElementById('rpPassword').value = '';
            document.getElementById('rpMessage').innerHTML = '';
            rpOverlay.classList.add('open');
          });
        }
      }

      /* ============ Reset password modal ============ */

      document.getElementById('rpGenBtn').addEventListener('click', () => {
        document.getElementById('rpPassword').value = genPassword(14);
      });
      document.getElementById('rpCancelBtn').addEventListener('click', () => {
        rpOverlay.classList.remove('open');
      });
      document.getElementById('rpSaveBtn').addEventListener('click', async () => {
        const pw = document.getElementById('rpPassword').value;
        const msgEl = document.getElementById('rpMessage');
        if (!pw || pw.length < 8) {
          msgEl.innerHTML = '<div class="modal-error">Password must be at least 8 characters.</div>';
          return;
        }
        const saveBtn = document.getElementById('rpSaveBtn');
        saveBtn.disabled = true; saveBtn.textContent = 'Resetting...';
        try {
          await postJSON('/sysadmin/api/reset-password', {
            user_id: currentUser.id,
            new_password: pw
          });
          msgEl.innerHTML = '<div class="modal-success">Password reset successfully. Share the new password with the user securely.</div>';
          toast('Password reset for ' + currentUser.email, 'ok');
          // Don't auto-close — let admin copy the password first
        } catch (err) {
          msgEl.innerHTML = '<div class="modal-error">' + escHtml(err.message) + '</div>';
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Reset password';
        }
      });

      /* ============ Create user modal ============ */

      const newBtn = document.getElementById('newUserBtn');
      if (newBtn) {
        newBtn.addEventListener('click', () => {
          document.getElementById('cuEmail').value = '';
          document.getElementById('cuPassword').value = '';
          document.getElementById('cuRole').value = '';
          document.querySelectorAll('.cu-tool').forEach(c => c.checked = false);
          document.getElementById('cuMessage').innerHTML = '';
          cuOverlay.classList.add('open');
        });
      }
      document.getElementById('cuGenBtn').addEventListener('click', () => {
        document.getElementById('cuPassword').value = genPassword(14);
      });
      document.getElementById('cuCancelBtn').addEventListener('click', () => {
        cuOverlay.classList.remove('open');
      });
      document.getElementById('cuSaveBtn').addEventListener('click', async () => {
        const email    = document.getElementById('cuEmail').value.trim();
        const password = document.getElementById('cuPassword').value;
        const role     = document.getElementById('cuRole').value;
        const tools    = Array.from(document.querySelectorAll('.cu-tool:checked')).map(c => c.value);
        const msgEl    = document.getElementById('cuMessage');

        if (!email || !email.includes('@')) {
          msgEl.innerHTML = '<div class="modal-error">Valid email required.</div>'; return;
        }
        if (!password || password.length < 8) {
          msgEl.innerHTML = '<div class="modal-error">Password must be at least 8 characters.</div>'; return;
        }

        // Confirm if setting super_admin
        if (role === 'super_admin') {
          const ok = await confirmDialog(
            'Create user as super_admin?',
            'This new user will have full admin access. Continue?'
          );
          if (!ok) return;
        }

        const saveBtn = document.getElementById('cuSaveBtn');
        saveBtn.disabled = true; saveBtn.textContent = 'Creating...';
        try {
          await postJSON('/sysadmin/api/create-user', { email, password, role: role || null, tools });
          msgEl.innerHTML = '<div class="modal-success">User created successfully. Reload the page to see them in the list.</div>';
          toast('Created user ' + email, 'ok');
          // Auto-reload after a short delay so they see the new user in the list
          setTimeout(() => location.reload(), 1500);
        } catch (err) {
          msgEl.innerHTML = '<div class="modal-error">' + escHtml(err.message) + '</div>';
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Create user';
        }
      });

    })();
    </script>`;
}

function renderLocationsPlaceholder() {
  return `
    <div class="card">
      <h2 class="section-h">Locations</h2>
      <h1>Manage pricing_simple</h1>
      <p>Add, edit, or remove rows in the pricing configuration table. All changes are logged.</p>
      <div class="placeholder">
        Coming in Phase 4.<br/>
        <span style="font-size:12px;">Add locations, edit any field, delete with confirmation \u2014 all without SQL.</span>
      </div>
    </div>`;
}
