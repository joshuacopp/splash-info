// Server-side fetch helper for /pertrack/api/* — apps/web's pages call the
// performance-worker's JSON API.
//
// DUAL-MODE TRANSPORT (Brief 17):
//
//   PRODUCTION / STAGING (Cloudflare Workers runtime):
//     env.PERFORMANCE_WORKER (service binding declared in apps/web/wrangler.toml)
//     is called directly — env.PERFORMANCE_WORKER.fetch(req). Cloudflare
//     routes the request internally without going back through the edge.
//     This avoids CF's same-zone Worker-to-Worker subrequest gotcha
//     (URL-based same-zone fetches loop through the edge and 522 after ~19s).
//
//   DEV (next dev outside the Workers runtime):
//     getCloudflareContext() throws or env.PERFORMANCE_WORKER is undefined.
//     We fall through to the URL-based fetch path. The URL is built from
//     NEXT_PUBLIC_PERFORMANCE_WORKER_URL when set (cross-origin dev) or the
//     request host when unset (same-origin via next.config.mjs rewrites).
//     CF Workers fetch doesn't accept relative URLs server-side, which is
//     why we always build an absolute URL in this branch.
//
// POST helper is JSON-bodied (performancePostJson) — performance-worker
// reads request.json() for /api/submissions and /api/login (apps/performance-
// worker/src/index.ts:215, 135), NOT @splash/http readForm.
//
// Auth posture: forwards the user's unified session cookie set by
// dashboard-worker. checkToolAccess(session, "pertrack") gates everything
// except /api/login, /api/logout, /api/me. Non-super_admin callers need the
// "pertrack" tool grant; 401/403 collapses to null on GET (mirror damage).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_PERFORMANCE_WORKER_URL;
  if (base) {
    return `${base}${trimmed}`;
  }
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

/**
 * GET a JSON endpoint, forwarding the user's auth cookie.
 *
 *   - Returns parsed JSON on 2xx.
 *   - Returns null on 401/403 (caller renders the no-access card).
 *   - Throws on other non-2xx (5xx, malformed JSON).
 */
export async function performanceGetJson<T>(path: string): Promise<T | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.PERFORMANCE_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const req = new Request(`https://internal${trimmed}`, {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      resp = await env.PERFORMANCE_WORKER.fetch(req);
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
 * Which branch of the dual-mode transport actually ran.
 *
 *   "binding"  — env.PERFORMANCE_WORKER.fetch(). The intended production path.
 *   "url"      — getCloudflareContext() resolved but the binding was missing.
 *   "url-throw" — getCloudflareContext() itself threw (expected only in dev).
 *
 * The two URL values are kept apart because they mean different things in a
 * deployed Worker: "url" says the service binding didn't make it into the
 * deploy, "url-throw" says we're not in the Workers runtime at all.
 */
export type PostTransport = "binding" | "url" | "url-throw";

export type PerformancePostResult =
  | { ok: true; body: unknown; via: PostTransport; ms: number }
  | { ok: false; status: number; error: string; via: PostTransport; ms: number };

/**
 * DIAGNOSTIC (2026-08-20), and meant to be removed once the answer is in.
 *
 * Saves on /admin/expenses and /admin/greeters take ~20s. Both pages run
 * entirely different SQL, so the shared cost is this transport, not the
 * database. `${via}-${ms}` is appended to the post-save redirect so one
 * ordinary save reports which branch ran and how long the worker call took —
 * no tail, no log scraping, it lands in the address bar.
 *
 * If this ever reads "url-<something near 20000>", the fallback is taking the
 * same-zone edge loop the header comment above was written to avoid.
 */
export function transportTag(result: PerformancePostResult): string {
  return `${result.via}-${result.ms}`;
}

/**
 * POST a JSON body to a performance-worker endpoint. Forwards the auth
 * cookie. Sets Origin explicitly so the worker's isOriginAllowed CSRF gate
 * passes (server-side fetch doesn't auto-populate Origin). Under the
 * service binding, the host is the placeholder `https://internal` and
 * the worker's isOriginAllowed accepts the apps/web-derived Origin header
 * the same way it does in the URL-based fallback.
 *
 * Return shape mirrors damagePostForm: { ok: true, body } on 2xx,
 * { ok: false, status, error } on non-2xx. Doesn't throw on auth failures —
 * callers (server actions) surface them via redirect-with-action_error.
 */
export async function performancePostJson<T>(
  path: string,
  body: T
): Promise<PerformancePostResult> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const stringified = JSON.stringify(body);

  let resp: Response;
  let via: PostTransport = "binding";
  const startedAt = Date.now();
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.PERFORMANCE_WORKER) {
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
      resp = await env.PERFORMANCE_WORKER.fetch(req);
    } else {
      via = "url";
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
    via = "url-throw";
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

  // Measured around the worker call only, deliberately: it has to be possible
  // to say "the transport was 19s and everything else was 300ms" rather than
  // "the save was 20s", which is what we already knew.
  const ms = Date.now() - startedAt;

  const ct = resp.headers.get("content-type") ?? "";
  let parsed: unknown = null;
  let rawText: string | null = null;
  if (ct.includes("application/json")) {
    parsed = await resp.json().catch(() => null);
  } else {
    rawText = await resp.text().catch(() => null);
  }

  if (resp.ok) {
    return { ok: true, body: parsed ?? rawText, via, ms };
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
  return { ok: false, status: resp.status, error, via, ms };
}
