// Server-side fetch helper for /pertrack/api/* — apps/web's pages call the
// performance-worker's JSON API.
//
// Mirrors apps/web/app/admin/damage/_lib/worker-fetch.ts in shape; differences:
//   - Cross-origin dev base = NEXT_PUBLIC_PERFORMANCE_WORKER_URL.
//   - Worker calls go to /pertrack/api/...; the prefix is the worker's
//     production mount and the worker no-ops the strip on workers.dev URLs
//     (apps/performance-worker/src/index.ts:69-74), so the same path works
//     in both dev cross-origin and prod same-origin.
//   - POST helper is JSON-bodied (performancePostJson) — performance-worker
//     reads request.json() for /api/submissions and /api/login (lines 215,
//     135), NOT @splash/http readForm.
//
// Auth posture: forwards the user's unified session cookie set by
// dashboard-worker. checkToolAccess(session, "pertrack") gates everything
// except /api/login, /api/logout, /api/me. Non-super_admin callers need the
// "pertrack" tool grant; 401/403 collapses to null on GET (mirror damage).

import { cookies, headers } from "next/headers";

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

export type PerformancePostResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

/**
 * POST a JSON body to a performance-worker endpoint. Forwards the auth
 * cookie. Sets Origin explicitly so the worker's isOriginAllowed CSRF gate
 * passes (server-side fetch doesn't auto-populate Origin).
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
