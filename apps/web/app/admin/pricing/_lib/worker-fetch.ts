// Server-side fetch helper for /admin/api/* — apps/web's pages call the
// signup-worker's JSON API for pricing data.
//
// URL CONSTRUCTION HAS TWO MODES:
//
//   1. NEXT_PUBLIC_SIGNUP_WORKER_URL is set (dev / staging cross-origin)
//      The signup-worker lives on a different origin than apps/web (e.g.,
//      apps/web on localhost:3001, signup-worker on splash-signup-next.<acct>.workers.dev).
//      We use the env var as the absolute base. This unblocks admin pricing
//      testing in dev — without this fork the request would resolve to
//      localhost:3001/admin/api/locations and 404 on apps/web.
//
//   2. NEXT_PUBLIC_SIGNUP_WORKER_URL is empty (production same-origin)
//      Post-cutover, apps/web AND signup-worker:/admin/api/* are both bound
//      to splashcarwashes.info. We build the URL from the incoming request's
//      host so the same code works without env-var configuration in prod.
//      Cloudflare's edge routes splashcarwashes.info/admin/api/* to
//      signup-worker per the wrangler.toml route binding. The cookie is
//      same-origin (set on splashcarwashes.info), attaches to the incoming
//      apps/web request automatically, and is forwarded explicitly via the
//      Cookie header on the worker subrequest below.
//
// CF Workers fetch doesn't accept relative URLs server-side, which is why
// we always build an absolute URL.

import { cookies, headers } from "next/headers";

/**
 * Build an absolute URL for a /admin/api/* call. Server-only — uses
 * next/headers which is unavailable in client components.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  // Mode 1: explicit base from env (dev cross-origin).
  const base = process.env.NEXT_PUBLIC_SIGNUP_WORKER_URL;
  if (base) {
    return `${base}${trimmed}`;
  }
  // Mode 2: same-origin via the request host (production post-cutover).
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

/**
 * GET a JSON endpoint, forwarding the user's auth cookie.
 *
 *   - Returns parsed JSON on 2xx.
 *   - Returns null on 401/403 (caller decides — typically render a
 *     "no access" page).
 *   - Throws on other non-2xx (5xx, malformed JSON, etc.) — caller's
 *     error boundary handles.
 */
export async function workerGetJson<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const url = await workerUrl(path);

  const resp = await fetch(url, {
    method: "GET",
    headers: { Cookie: cookieStore.toString() },
    cache: "no-store"
  });

  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) {
    throw new Error(`Worker GET ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}
