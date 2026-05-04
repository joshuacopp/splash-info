// Tiny HTTP helpers shared by every Splash worker.
//
// Packaged after the third copy appeared (dashboard-worker + performance-worker
// + sysadmin-worker — each was rewriting the same 6 lines). No deps on other
// @splash/* packages by design.
//
// Surface:
//   json(body, status?)           — generic JSON response
//   jsonError(status, message)    — convenience for `json({ error: msg }, status)`
//   readForm(request)             — content-type-aware body parser → URLSearchParams
//   isOriginAllowed(request)      — same-origin CSRF defense-in-depth

/**
 * Build a JSON Response with `Content-Type: application/json`. Status
 * defaults to 200. Pass any value that `JSON.stringify` accepts.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Build a JSON error response. Equivalent to
 * `json({ error: message }, status)` but reads better at the call site
 * when the response is unambiguously an error.
 */
export function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

/**
 * Content-type-aware body parser. Returns a URLSearchParams populated from
 * the body (form-encoded, multipart, or JSON) or the URL query string as a
 * fallback. Source: legacy/dashboard.js:161 readForm + legacy/signupworker.js:3306.
 *
 * NOTE on multipart: file fields are stripped (set to ""). For endpoints that
 * accept file uploads (e.g., damage-worker /claims-api/submit-claim), call
 * `request.formData()` directly and use `.get()` / `.getAll()` on the
 * FormData — the URLSearchParams shape this helper returns can't carry File
 * values.
 */
export async function readForm(request: Request): Promise<URLSearchParams> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await request.text());
  }
  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    const sp = new URLSearchParams();
    fd.forEach((v, k) => sp.set(k, typeof v === "string" ? v : ""));
    return sp;
  }
  if (ct.includes("application/json")) {
    const obj = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) sp.set(k, String(v));
    return sp;
  }
  return new URLSearchParams(new URL(request.url).search);
}

/**
 * True iff `origin` is a localhost-shaped URL. Used by isOriginAllowed
 * below to carve out dev traffic. Production never has localhost origins
 * (no public DNS routes localhost), so this is safe.
 */
function isLocalhostOrigin(origin: string): boolean {
  return (
    origin === "http://localhost" ||
    origin === "https://localhost" ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("https://localhost:") ||
    origin === "http://127.0.0.1" ||
    origin.startsWith("http://127.0.0.1:")
  );
}

/**
 * Same-origin check for state-changing POST handlers. Defense-in-depth
 * over SameSite=Lax cookies — same-origin browsers send `Origin`, and a
 * cross-origin form submit either omits it or sets a different value.
 *
 * Returns true iff the request's Origin (or Referer fallback) matches
 * the request URL's origin. Returns false when both headers are missing
 * (refuse rather than guess — matches legacy/damagemanager.js:2939).
 *
 * DEV CARVE-OUT: localhost-shaped origins are accepted unconditionally.
 * apps/web's dev server proxies browser POSTs from localhost:NNNN to
 * workers.dev URLs (via next.config.mjs rewrites), and the browser's
 * Origin header (localhost:NNNN) is preserved through the proxy and
 * doesn't match the worker's expected origin. Without this carve-out,
 * every client-side POST 403s in dev. Production never has localhost
 * traffic — no public DNS routes localhost, CF edge wouldn't route a
 * localhost request to a worker anyway.
 *
 * Source: legacy/damagemanager.js:2939 checkOrigin.
 *
 * Caller pattern in mutation handlers:
 *
 *     if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
 */
export function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const url = new URL(request.url);
  const expected = `${url.protocol}//${url.host}`;

  if (origin) {
    if (origin === expected) return true;
    if (isLocalhostOrigin(origin)) return true;
    return false;
  }
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (refOrigin === expected) return true;
      if (isLocalhostOrigin(refOrigin)) return true;
      return false;
    } catch {
      return false;
    }
  }
  // No Origin or Referer header — refuse rather than guess.
  return false;
}
