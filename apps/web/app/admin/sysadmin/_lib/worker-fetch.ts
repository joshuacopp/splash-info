// Server-side fetch helper for /sysadmin/api/* — apps/web's pages call the
// sysadmin-worker's JSON API for super_admin user-management mutations.
//
// Mirror of apps/web/app/admin/damage/_lib/worker-fetch.ts. Same dev-vs-prod
// URL fork; same Cookie + Origin forwarding; same { ok, body } / { ok: false,
// status, error } return shape on POST.
//
// IMPORTANT: sysadmin-worker reads JSON for all 5 mutation endpoints (it
// calls request.json()), NOT form-encoded bodies. So sysadminPostJson sets
// Content-Type: application/json and stringifies an object — different from
// damagePostForm's URL-encoded body.
//
// URL CONSTRUCTION HAS TWO MODES:
//
//   1. NEXT_PUBLIC_SYSADMIN_WORKER_URL is set (dev / staging cross-origin)
//      The sysadmin-worker lives on a different origin than apps/web. Use
//      the env var as the absolute base.
//
//   2. NEXT_PUBLIC_SYSADMIN_WORKER_URL is empty (production same-origin)
//      Post-cutover, apps/web AND sysadmin-worker:/sysadmin/api/* both bind
//      to splashcarwashes.info. Build the URL from the incoming request's
//      host so the same code works without env-var configuration.

import { cookies, headers } from "next/headers";

/**
 * Build an absolute URL for a /sysadmin/api/* call. Server-only — uses
 * next/headers which is unavailable in client components.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_SYSADMIN_WORKER_URL;
  if (base) {
    return `${base}${trimmed}`;
  }
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

/**
 * GET a JSON endpoint, forwarding the user's auth cookie. The sysadmin-worker
 * exposes no GET endpoints today (all 5 are POST mutations), but the helper
 * is included for shape-parity with the rest of the apps/web admin helpers.
 *
 *   - Returns parsed JSON on 2xx.
 *   - Returns null on 401/403.
 *   - Throws on other non-2xx.
 */
export async function sysadminGetJson<T>(path: string): Promise<T | null> {
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

/**
 * POST a JSON body to a sysadmin-worker mutation endpoint. Server-only.
 *
 * Stringifies the body object as application/json — matches the worker's
 * request.json() read in apps/sysadmin-worker/src/index.ts:89.
 *
 * Sets the `Origin` header to the target URL's origin so the worker's
 * `isOriginAllowed` CSRF check passes — server-side fetch doesn't auto-set
 * Origin and the worker rejects mutations without a matching Origin/Referer.
 *
 * Return shape:
 *   - { ok: true,  body }                  on 2xx
 *   - { ok: false, status, error }         on non-2xx
 * Doesn't throw on auth/scope/validation failures — the caller surfaces them
 * inline (server actions redirect with ?action_error=...).
 */
export type SysadminPostResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

export async function sysadminPostJson<T>(
  path: string,
  body: T
): Promise<SysadminPostResult> {
  const cookieStore = await cookies();
  const url = await workerUrl(path);
  const targetOrigin = new URL(url).origin;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: cookieStore.toString(),
      "Content-Type": "application/json",
      Origin: targetOrigin
    },
    body: JSON.stringify(body),
    cache: "no-store"
  });

  const ct = resp.headers.get("content-type") ?? "";
  let parsed: unknown = null;
  let rawText: string | null = null;
  if (ct.includes("application/json")) {
    parsed = await resp.json().catch(() => null);
  } else {
    rawText = await resp.text().catch(() => null);
  }

  if (resp.ok) {
    return { ok: true, body: parsed ?? rawText };
  }

  let error: string;
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error?: unknown }).error === "string"
  ) {
    error = (parsed as { error: string }).error;
  } else if (rawText) {
    error = rawText;
  } else {
    error = `Worker POST failed: ${resp.status}`;
  }
  return { ok: false, status: resp.status, error };
}
