// Server-side fetch helper for /manage/api/* — apps/web's pages call the
// damage-worker's JSON API for claims data.
//
// URL CONSTRUCTION HAS TWO MODES:
//
//   1. NEXT_PUBLIC_DAMAGE_WORKER_URL is set (dev / staging cross-origin)
//      The damage-worker lives on a different origin than apps/web (e.g.,
//      apps/web on localhost:3001, damage-worker on splash-damage.<acct>.workers.dev).
//      We use the env var as the absolute base. Without this fork the request
//      would resolve to localhost:3001/manage/api/claims and 404 on apps/web.
//
//   2. NEXT_PUBLIC_DAMAGE_WORKER_URL is empty (production same-origin)
//      Post-cutover, apps/web AND damage-worker:/manage/api/* are both bound
//      to splashcarwashes.info. We build the URL from the incoming request's
//      host so the same code works without env-var configuration in prod.
//      Cloudflare's edge routes splashcarwashes.info/manage/api/* to
//      damage-worker per the wrangler.toml route binding. The cookie is
//      same-origin (set on splashcarwashes.info), attaches to the incoming
//      apps/web request automatically, and is forwarded explicitly via the
//      Cookie header on the worker subrequest below.
//
// CF Workers fetch doesn't accept relative URLs server-side, which is why
// we always build an absolute URL.
//
// Lives in a damage-namespaced location so future damage-worker calls don't
// share state with the pricing helper.

import { cookies, headers } from "next/headers";

/**
 * Build an absolute URL for a /manage/api/* call. Server-only — uses
 * next/headers which is unavailable in client components.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  // Mode 1: explicit base from env (dev cross-origin).
  const base = process.env.NEXT_PUBLIC_DAMAGE_WORKER_URL;
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
export async function damageGetJson<T>(path: string): Promise<T | null> {
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
  const cookieStore = await cookies();
  const url = await workerUrl(path);

  const resp = await fetch(url, {
    method: "GET",
    headers: { Cookie: cookieStore.toString() },
    cache: "no-store"
  });

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
 */
export async function damagePhotoUrl(r2Key: string): Promise<string> {
  const stripped = r2Key.startsWith("claims/") ? r2Key.slice("claims/".length) : r2Key;
  const segments = stripped.split("/").map(encodeURIComponent).join("/");
  // workerUrl handles base/prod-host distinction and prepends the leading /.
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
 * Origin/Referer.
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
  const url = await workerUrl(path);
  const targetOrigin = new URL(url).origin;

  const params = new URLSearchParams();
  for (const [k, v] of formData.entries()) {
    params.append(k, typeof v === "string" ? v : "");
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: cookieStore.toString(),
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: targetOrigin
    },
    body: params.toString(),
    cache: "no-store"
  });

  return parseDamagePostResponse(resp);
}

/**
 * POST a multipart/form-data body to a damage-worker mutation endpoint.
 * Server-only. Companion to `damagePostForm` — same return shape, same
 * Cookie/Origin forwarding, but designed for endpoints that accept file
 * uploads (currently only POST /manage/api/claim/{id}/document).
 *
 * Critical: we deliberately DO NOT set the Content-Type header. fetch
 * (undici) populates `multipart/form-data; boundary=...` automatically when
 * the body is a FormData instance — manually setting Content-Type here
 * strips the boundary and the worker's request.formData() call returns an
 * empty FormData, dropping the file field silently.
 *
 * The damage-worker's upload handler reads the multipart body via
 * `request.formData()` directly (NOT via @splash/http readForm — readForm
 * stringifies file values to ""). Field names on the body are forwarded
 * verbatim; the calling form is responsible for matching the worker's
 * expected names (doc_type, file, vendor, amount, notes, pay_to_type,
 * vendor_address).
 */
export async function damagePostMultipart(
  path: string,
  formData: FormData
): Promise<DamagePostResult> {
  const cookieStore = await cookies();
  const url = await workerUrl(path);
  const targetOrigin = new URL(url).origin;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: cookieStore.toString(),
      Origin: targetOrigin
      // NO Content-Type — fetch sets multipart boundary itself.
    },
    body: formData,
    cache: "no-store"
  });

  return parseDamagePostResponse(resp);
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
