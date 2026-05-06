// Server-side fetch helper for the damage-worker (claims data + write
// actions). apps/web's pages call these helpers from server components
// and server actions. Brief 37 retired `damagePostMultipart` along with
// `uploadDocumentAction` — the document upload form now POSTs directly
// to the damage-worker bypass apps/web entirely (see
// `_components/UploadDocumentCard.tsx`).
//
// DUAL-MODE TRANSPORT (Brief 17):
//
//   PRODUCTION / STAGING (Cloudflare Workers runtime):
//     env.DAMAGE_WORKER (service binding declared in apps/web/wrangler.toml)
//     is called directly — env.DAMAGE_WORKER.fetch(req). Cloudflare routes
//     the request internally without going back through the edge. This
//     avoids CF's same-zone Worker-to-Worker subrequest gotcha (URL-based
//     same-zone fetches loop through the edge and 522 after ~19s).
//
//   DEV (next dev outside the Workers runtime):
//     getCloudflareContext() throws or env.DAMAGE_WORKER is undefined. We
//     fall through to the URL-based fetch path. The URL is built from the
//     NEXT_PUBLIC_DAMAGE_WORKER_URL env var when set (cross-origin dev) or
//     the request host when unset (same-origin via next.config.mjs rewrites).
//     CF Workers fetch doesn't accept relative URLs server-side, which is
//     why we always build an absolute URL in this branch.
//
// HOST PLACEHOLDER:
//   Service bindings ignore the URL host; only the path matters. Use
//   `https://internal` consistently across helpers so logs are predictable.
//
// PHOTO URLS (damagePhotoUrl, damageCheckRequestUrl):
//   Both return absolute URLs that are dropped into <img src> or <a href> —
//   the browser fetches them, not the apps/web Worker. Service bindings
//   don't apply. Stay URL-based and use the same env var / request-host
//   resolution as the dev fallback.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Build an absolute URL for a damage-worker call, used both by the
 * URL-based dev fallback and by the photo-URL helpers (where the browser
 * is the consumer, not the Worker). Server-only.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_DAMAGE_WORKER_URL;
  if (base) {
    return `${base}${trimmed}`;
  }
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

/**
 * GET via service binding when available, falling back to a URL fetch in
 * dev. Returns the raw Response so each public helper can implement its
 * own status-handling contract.
 */
async function damageGetResponse(path: string): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.DAMAGE_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const req = new Request(`https://internal${trimmed}`, {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      return env.DAMAGE_WORKER.fetch(req);
    }
  } catch {
    // Fall through to URL-based fetch (next dev / non-Workers runtime).
  }

  const url = await workerUrl(path);
  return fetch(url, {
    method: "GET",
    headers: { Cookie: cookieHeader },
    cache: "no-store"
  });
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
export async function damageGetJson<T>(path: string): Promise<T | null> {
  const resp = await damageGetResponse(path);
  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) {
    throw new Error(`Worker GET ${path} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

/**
 * Variant of damageGetJson that surfaces the HTTP status on every non-2xx
 * branch instead of collapsing 401/403 into null and throwing on the rest.
 * The detail page (/admin/damage/[id]) needs to distinguish 404
 * ("claim not found or out of scope") from 500-class errors so the UX can
 * render the right card.
 *
 * Returns either { data } on 2xx or { status } otherwise. The original
 * damageGetJson stays for 5a's contract.
 */
export type DamageGetResult<T> = { data: T } | { status: number };

export async function damageGetJsonOrStatus<T>(
  path: string
): Promise<DamageGetResult<T>> {
  const resp = await damageGetResponse(path);
  if (!resp.ok) return { status: resp.status };
  return { data: (await resp.json()) as T };
}

/**
 * Build an absolute URL for the public R2 photo-serving endpoint
 * /claims-api/photo/{r2-key-suffix...}. Used from server components only —
 * uses next/headers same as workerUrl().
 *
 * The r2_key on claim_photos is stored as `claims/{claimId}/{slug}_{n}.{ext}`.
 * The damage-worker route is `/claims-api/photo/{rest}` and serveClaimPhoto
 * prepends "claims/" before the bucket lookup, so we strip the leading
 * "claims/" from r2_key when constructing the URL path.
 *
 * No auth on this endpoint (public per legacy:5666); no Cookie header
 * needed. Returns an absolute URL safe to drop into <img src>.
 *
 * NOTE: stays URL-based (not service-bound) — the browser fetches this URL,
 * not the apps/web Worker, so the same-zone subrequest concern doesn't apply.
 */
export async function damagePhotoUrl(r2Key: string): Promise<string> {
  const stripped = r2Key.startsWith("claims/") ? r2Key.slice("claims/".length) : r2Key;
  const segments = stripped.split("/").map(encodeURIComponent).join("/");
  return workerUrl(`/claims-api/photo/${segments}`);
}

/**
 * Build an absolute URL for the check-request PDF preview endpoint.
 * GET /manage/api/claim/{claimId}/quote/{quoteId}/preview-check-request.pdf.
 *
 * The endpoint is auth-gated. SameSite=Lax cookies attach automatically on
 * top-level navigation (target=_blank link click), so this URL is safe to
 * drop directly into an <a href> — no extra plumbing needed for cross-origin
 * dev or same-origin prod.
 *
 * Stays URL-based for the same reason as damagePhotoUrl — the browser is
 * the consumer.
 */
export async function damageCheckRequestUrl(
  claimId: string,
  quoteId: number
): Promise<string> {
  return workerUrl(
    `/manage/api/claim/${encodeURIComponent(claimId)}/quote/${encodeURIComponent(
      String(quoteId)
    )}/preview-check-request.pdf`
  );
}

/**
 * POST a form-encoded body to a damage-worker mutation endpoint, forwarding
 * the user's auth cookie. Server-only.
 *
 * Encodes as `application/x-www-form-urlencoded` to match the worker's
 * `readForm` primary content-type branch (any FormData file values are
 * serialised to empty strings; this helper is for the note + transition
 * forms, neither of which carries files).
 *
 * Sets the `Origin` header to the target URL's origin so the worker's
 * `isOriginAllowed` CSRF check passes — server-side fetch wouldn't set
 * Origin otherwise, and the worker rejects mutations without a matching
 * Origin/Referer. Under the service binding the host is the placeholder
 * `https://internal` and the worker's isOriginAllowed accepts the
 * apps/web-derived Origin header same as in the URL-based fallback.
 *
 * Return shape:
 *   - { ok: true,  body }                      on 2xx
 *   - { ok: false, status, error }             on non-2xx
 * Doesn't throw on auth/scope failures — the caller decides how to surface
 * them inline (error-banner redirect for server actions; per-call branching
 * elsewhere).
 */
export type DamagePostResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

export async function damagePostForm(
  path: string,
  formData: FormData
): Promise<DamagePostResult> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const params = new URLSearchParams();
  for (const [k, v] of formData.entries()) {
    params.append(k, typeof v === "string" ? v : "");
  }
  const body = params.toString();

  const resp = await damagePost(path, body, {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookieHeader
  });
  return parseDamagePostResponse(resp);
}

/**
 * Internal POST dispatcher: prefers env.DAMAGE_WORKER service binding,
 * falls back to URL-based fetch in dev. Sets `Origin` to the target URL's
 * origin so the worker's isOriginAllowed CSRF gate passes.
 */
async function damagePost(
  path: string,
  body: BodyInit,
  baseHeaders: Record<string, string>
): Promise<Response> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.DAMAGE_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const url = `https://internal${trimmed}`;
      const req = new Request(url, {
        method: "POST",
        headers: { ...baseHeaders, Origin: new URL(url).origin },
        body
      });
      return env.DAMAGE_WORKER.fetch(req);
    }
  } catch {
    // Fall through to URL-based fetch (next dev / non-Workers runtime).
  }

  const url = await workerUrl(path);
  return fetch(url, {
    method: "POST",
    headers: { ...baseHeaders, Origin: new URL(url).origin },
    body,
    cache: "no-store"
  });
}

/** Shared response parser for POST helpers. JSON-aware with text fallback. */
async function parseDamagePostResponse(resp: Response): Promise<DamagePostResult> {
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
