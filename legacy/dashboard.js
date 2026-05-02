/* ===================================================================
   SPLASH CAR WASHES - DASHBOARD WORKER
   Route: splashcarwashes.info/  (root only)
   
   Purpose:
   - Landing page for splashcarwashes.info
   - Single sign-on entry point
   - Routes authenticated users to /admin, /manage, or /pertrack
   
   Sets the same Supabase auth cookies as signup-worker, with Path=/
   so /admin, /manage, and /pertrack all share the session.
=================================================================== */

addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});

/* ============= ROUTER ============= */

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Login form submission
  if (path === "/login" && method === "POST") {
    return handleLogin(request);
  }

  // Logout - clear cookies, redirect to root
  if (path === "/logout") {
    return handleLogout();
  }

  // Root - show dashboard if logged in, login page otherwise
  if (path === "/" || path === "") {
    return handleRoot(request);
  }

  // Anything else on root worker → 404
  // (Other paths are handled by other workers via Cloudflare routes)
  return new Response("Not found", { status: 404 });
}

/* ============= ROOT HANDLER ============= */

async function handleRoot(request) {
  const authResult = await checkAuth(request);

  if (!authResult.authenticated) {
    // Capture redirect param so we can bounce them back after login
    const url = new URL(request.url);
    const redirectTo = url.searchParams.get("redirect") || "";
    return html(200, renderLoginPage("", redirectTo));
  }

  // Logged in - show dashboard
  return html(200, renderDashboard(authResult.user));
}

/* ============= AUTH ============= */

async function handleLogin(request) {
  const form = await readForm(request);
  const email = (form.get("email") || "").trim();
  const password = (form.get("password") || "").trim();
  const redirectTo = (form.get("redirect") || "").trim();

  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });

  if (!authResponse.ok) {
    return html(401, renderLoginPage("Invalid email or password", redirectTo));
  }

  const authData = await authResponse.json();

  // Validate the redirect target - only allow same-origin paths to known tools
  const safeRedirect = sanitizeRedirect(redirectTo);

  return new Response("", {
    status: 302,
    headers: {
      "Location": safeRedirect,
      "Set-Cookie":
        `sb-access-token=${authData.access_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600, ` +
        `sb-refresh-token=${authData.refresh_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
    }
  });
}

async function handleLogout() {
  return new Response("", {
    status: 302,
    headers: {
      "Location": "/",
      "Set-Cookie":
        "sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0, " +
        "sb-refresh-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}

async function checkAuth(request) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const accessToken = cookies["sb-access-token"];

  if (!accessToken) {
    return { authenticated: false };
  }

  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${accessToken}`
    }
  });

  if (!userResponse.ok) {
    return { authenticated: false };
  }

  const user = await userResponse.json();
  return { authenticated: true, user };
}

/* ============= HELPERS ============= */

function sanitizeRedirect(redirect) {
  // Only allow redirects to /admin, /manage, /pertrack (and their subpaths)
  // Default to root dashboard if anything looks off
  if (!redirect) return "/";
  if (!redirect.startsWith("/")) return "/";
  if (redirect.startsWith("//")) return "/"; // protocol-relative - reject

  const allowed = ["/admin", "/manage", "/pertrack"];
  for (const prefix of allowed) {
    if (redirect === prefix || redirect.startsWith(prefix + "/") || redirect.startsWith(prefix + "?")) {
      return redirect;
    }
  }
  return "/";
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name) cookies[name] = rest.join("=");
  });
  return cookies;
}

async function readForm(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return new URLSearchParams(text);
  }
  if (ct.includes("multipart/form-data")) {
    return await request.formData();
  }
  return new URLSearchParams();
}

function html(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
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

/* ============= RENDER ============= */

const ASSETS = {
  logoWhite: "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png",
  logoBlue: "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full%20(1)%201.png",
  favicon: "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png"
};

const FAVICON_LINK = `<link rel="icon" type="image/png" href="${ASSETS.favicon}"/>`;

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
    --gray-light: #dbdbdb;
    --gray-dark: #3a3f47;
    --white: #ffffff;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    min-height: 100vh;
  }
`;

const BRAND_FONT_LINK = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
`;

function renderLoginPage(error = "", redirectTo = "") {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#2b3491"/>
<title>Splash Car Washes - Sign In</title>
${FAVICON_LINK}
${BRAND_FONT_LINK}
<style>
  ${BRAND_STYLES}
  body { display: flex; align-items: center; justify-content: center; padding: 20px; }
  .login-card {
    width: 100%;
    max-width: 420px;
    background: var(--splash-navy);
    border: 3px solid var(--splash-navy);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .login-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: var(--white);
    padding: 28px 32px 24px;
    text-align: center;
  }
  .login-logo {
    display: block;
    height: 64px;
    width: auto;
    margin: 0 auto 12px;
    object-fit: contain;
  }
  .eyebrow {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--sudsy-blue);
    margin-bottom: 4px;
  }
  .login-header h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--white);
    line-height: 1.2;
  }
  .login-body { background: var(--white); padding: 26px 32px 28px; }
  .form-intro {
    color: var(--splash-navy);
    opacity: 0.75;
    font-size: 0.9375rem;
    margin: 0 0 18px;
    text-align: center;
  }
  .form-group { margin-bottom: 14px; }
  label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--splash-navy);
    margin-bottom: 6px;
  }
  .req { color: var(--sudsy-blue); font-weight: 700; }
  input {
    width: 100%;
    height: 42px;
    padding: 8px 14px;
    font-size: 0.9375rem;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: var(--white);
    border: 1.5px solid var(--gray-light);
    border-radius: var(--radius-sm);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  input::placeholder { color: #9aa0a6; }
  input:hover { border-color: var(--sudsy-blue); }
  input:focus {
    border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
    outline: none;
  }
  button {
    width: 100%;
    height: 46px;
    margin-top: 10px;
    font-family: var(--font-body);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--white);
    background: var(--splash-blue);
    border: none;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-btn);
    cursor: pointer;
    transition: background-color 0.2s ease, box-shadow 0.2s ease, transform 0.05s ease;
  }
  button:hover {
    background: var(--splash-blue-dark);
    box-shadow: 0 6px 16px rgba(43, 52, 145, 0.35);
  }
  button:active { transform: translateY(1px); }
  .error {
    margin-top: 14px;
    padding: 10px 14px;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--white);
    background: var(--racecar-red);
    border-radius: var(--radius-sm);
    text-align: center;
  }
</style>
</head>
<body>
  <div class="login-card">
    <div class="login-header">
      <img class="login-logo" src="${ASSETS.logoWhite}" alt="Splash Car Washes"/>
      <div class="eyebrow">Internal Tools</div>
      <h1>Sign In</h1>
    </div>
    <div class="login-body">
      <p class="form-intro">Sign in with your Splash account to continue.</p>
      <form method="POST" action="/login" autocomplete="on">
        <input type="hidden" name="redirect" value="${esc(redirectTo)}"/>
        <div class="form-group">
          <label for="email">Email Address <span class="req">*</span></label>
          <input type="email" id="email" name="email" placeholder="your.name@splashcarwashes.com" required autocomplete="email" autofocus/>
        </div>
        <div class="form-group">
          <label for="password">Password <span class="req">*</span></label>
          <input type="password" id="password" name="password" placeholder="Enter password" required autocomplete="current-password"/>
        </div>
        <button type="submit">Sign In</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ""}
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderDashboard(user) {
  const email = user.email || "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#2b3491"/>
<title>Splash Tools - Dashboard</title>
${FAVICON_LINK}
${BRAND_FONT_LINK}
<style>
  ${BRAND_STYLES}
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 36px 20px 48px;
  }
  .header {
    width: 100%;
    max-width: 1100px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--white);
    margin-bottom: 36px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 16px; }
  .brand-logo {
    height: 56px;
    width: auto;
    object-fit: contain;
    flex-shrink: 0;
  }
  .brand-text { display: flex; flex-direction: column; gap: 2px; }
  .brand-text .eyebrow {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--sudsy-blue);
  }
  .brand-text h1 {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 700;
    letter-spacing: -0.005em;
  }
  .user-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 0.875rem;
  }
  .user-bar .email { opacity: 0.85; }
  .user-bar a {
    color: var(--white);
    text-decoration: none;
    padding: 8px 16px;
    border: 1.5px solid rgba(255,255,255,0.4);
    border-radius: var(--radius-sm);
    font-weight: 600;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  .user-bar a:hover {
    background: rgba(255,255,255,0.12);
    border-color: rgba(255,255,255,0.7);
  }
  .grid {
    width: 100%;
    max-width: 1100px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
  }
  @media (min-width: 720px) {
    .grid { grid-template-columns: repeat(3, 1fr); }
  }
  .card {
    background: var(--white);
    border: 3px solid var(--splash-navy);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    text-decoration: none;
    color: var(--splash-navy);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: transform 0.15s ease, box-shadow 0.2s ease;
  }
  .card:hover {
    transform: translateY(-3px);
    box-shadow: 0 14px 40px rgba(28, 22, 78, 0.28);
  }
  .card-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    padding: 22px 24px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .card-icon {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    background: var(--white);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--splash-blue);
  }
  .card-icon svg { width: 26px; height: 26px; }
  .card-header-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .card-eyebrow {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--sudsy-blue);
  }
  .card-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--white);
    line-height: 1.2;
  }
  .card-body {
    padding: 18px 24px 22px;
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 14px;
  }
  .card-desc {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--splash-navy);
    opacity: 0.8;
    line-height: 1.5;
  }
  .card-cta {
    align-self: flex-start;
    font-size: 0.8125rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--splash-blue);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .card-cta svg { width: 14px; height: 14px; transition: transform 0.2s ease; }
  .card:hover .card-cta svg { transform: translateX(3px); }
</style>
</head>
<body>
  <header class="header">
    <div class="brand">
      <img class="brand-logo" src="${ASSETS.logoWhite}" alt="Splash Car Washes"/>
      <div class="brand-text">
        <span class="eyebrow">Internal Tools</span>
        <h1>Dashboard</h1>
      </div>
    </div>
    <div class="user-bar">
      <span class="email">${esc(email)}</span>
      <a href="/logout">Sign Out</a>
    </div>
  </header>

  <main class="grid">
    <a class="card" href="/admin">
      <div class="card-header">
        <div class="card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="card-header-text">
          <span class="card-eyebrow">Pricing</span>
          <span class="card-title">Pricing Admin</span>
        </div>
      </div>
      <div class="card-body">
        <p class="card-desc">Manage MaxPass signup pricing across all locations.</p>
        <span class="card-cta">Open <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>
      </div>
    </a>

    <a class="card" href="/manage">
      <div class="card-header">
        <div class="card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        </div>
        <div class="card-header-text">
          <span class="card-eyebrow">Service</span>
          <span class="card-title">Damage Claims</span>
        </div>
      </div>
      <div class="card-body">
        <p class="card-desc">Review and manage vehicle damage claims and resolutions.</p>
        <span class="card-cta">Open <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>
      </div>
    </a>

    <a class="card" href="/pertrack">
      <div class="card-header">
        <div class="card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/></svg>
        </div>
        <div class="card-header-text">
          <span class="card-eyebrow">Insights</span>
          <span class="card-title">Performance Tracking</span>
        </div>
      </div>
      <div class="card-body">
        <p class="card-desc">View location performance metrics and operational insights.</p>
        <span class="card-cta">Open <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>
      </div>
    </a>
  </main>
</body>
</html>`;
}

/* ============= ENV ============= */
// SUPABASE_URL and SUPABASE_ANON_KEY must be set as environment variables
// in the Cloudflare Worker dashboard (Settings → Variables and Secrets)
