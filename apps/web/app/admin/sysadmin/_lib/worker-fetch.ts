// Server-side fetch helper for /sysadmin/api/* — apps/web's pages call the
// sysadmin-worker's JSON API for super_admin user-management mutations.
//
// DUAL-MODE TRANSPORT (Brief 17):
//
//   PRODUCTION / STAGING (Cloudflare Workers runtime):
//     env.SYSADMIN_WORKER (service binding declared in apps/web/wrangler.toml)
//     is called directly — env.SYSADMIN_WORKER.fetch(req). Cloudflare routes
//     the request internally without going back through the edge. This
//     avoids CF's same-zone Worker-to-Worker subrequest gotcha (URL-based
//     same-zone fetches loop through the edge and 522 after ~19s).
//
//   DEV (next dev outside the Workers runtime):
//     getCloudflareContext() throws or env.SYSADMIN_WORKER is undefined.
//     We fall through to the URL-based fetch path. The URL is built from
//     NEXT_PUBLIC_SYSADMIN_WORKER_URL when set (cross-origin dev) or the
//     request host when unset (same-origin via next.config.mjs rewrites).
//     CF Workers fetch doesn't accept relative URLs server-side, which is
//     why we always build an absolute URL in this branch.
//
// IMPORTANT: sysadmin-worker reads JSON for all 5 mutation endpoints (it
// calls request.json()), NOT form-encoded bodies. So sysadminPostJson sets
// Content-Type: application/json and stringifies an object — different from
// damagePostForm's URL-encoded body.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Build an absolute URL for a /sysadmin/api/* call. Server-only — uses
 * next/headers which is unavailable in client components. Used by the
 * URL-based dev fallback.
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
  const cookieHeader = cookieStore.toString();

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.SYSADMIN_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const req = new Request(`https://internal${trimmed}`, {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      resp = await env.SYSADMIN_WORKER.fetch(req);
    } else {
      const url = await workerUrl(path);
      resp = await fetch(url, {
        method: "GET",
        headers: { Cookie: cookieHeader },
        cache: "no-store"
      });
    }
  } catch {
    const url = await workerUrl(path);
    resp = await fetch(url, {
      method: "GET",
      headers: { Cookie: cookieHeader },
      cache: "no-store"
    });
  }

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
 * Under the service binding, the host is the placeholder `https://internal`
 * and the worker's isOriginAllowed accepts the apps/web-derived Origin
 * header the same way it does in the URL-based fallback.
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
  const cookieHeader = cookieStore.toString();
  const stringified = JSON.stringify(body);

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.SYSADMIN_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const url = `https://internal${trimmed}`;
      const req = new Request(url, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          Origin: new URL(url).origin
        },
        body: stringified
      });
      resp = await env.SYSADMIN_WORKER.fetch(req);
    } else {
      const url = await workerUrl(path);
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          Origin: new URL(url).origin
        },
        body: stringified,
        cache: "no-store"
      });
    }
  } catch {
    const url = await workerUrl(path);
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: new URL(url).origin
      },
      body: stringified,
      cache: "no-store"
    });
  }

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
