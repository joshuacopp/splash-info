// Streams a part photo out of R2 — GET /admin/parts/directory/photo/{...key}.
//
// The URL shape is produced by `partPhotoUrl()` in ../../_lib/parts.ts, which
// encodes each path segment of the R2 key SEPARATELY so the slashes stay real
// separators. This catch-all is the other half of that contract: the segments
// are re-joined with "/" to reconstruct the key. Change one, change both.
//
// PREFIX GUARD — the load-bearing part. `splash-parts-manuals` is a SHARED
// bucket: the interactive parts manuals (multi-MB HTML at the bucket root, plus
// `manifest.json`) live in it too. Without a guard, this route is an arbitrary
// read primitive over that whole bucket. So a key must start with
// `parts-directory/` and must contain no `..` segment, and both checks run on
// the DECODED key — a `%2e%2e` that only gets decoded later would otherwise
// walk straight past a check done on the raw form.
//
// AUTH POSTURE — middleware only, matching ../../../[slug]/file/route.ts.
// This path is under /admin/*, so apps/web's middleware matcher ("/admin/:path*")
// fires and, having no `sb-access-token` cookie, 302s an anonymous caller to
// /login before the handler ever runs. That check is presence-only (it does not
// validate the JWT), which is exactly the posture the manuals serve route has
// had since it shipped, and it is the right one here: a directory page renders
// one <img> per part, and calling getMe() per image would mean a
// dashboard-worker round trip per thumbnail. The write paths, where a stale
// cookie actually matters, DO verify — see ../../_lib/admin-gate.ts.
//
// Cache-Control matches the claim-photo serve path in
// packages/storage-r2/src/index.ts: `public, max-age=86400`. Keys are
// content-addressed in practice (every upload gets a fresh UUID folder), so an
// object never changes under a URL and a day of caching is free.

import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

/** Only objects under this prefix are reachable through this route. */
const KEY_PREFIX = "parts-directory/";

const CACHE_CONTROL = "public, max-age=86400";

/**
 * Next decodes catch-all segments before handing them over, so in the normal
 * case this is a no-op. It runs anyway because `decodeURIComponent` is cheap
 * and a double-encoded segment reaching the guard undecoded is precisely the
 * traversal case we care about. A malformed escape throws — keep the raw
 * segment then, and let the prefix/`..` checks below judge it.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  const { key: segments } = await ctx.params;
  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  const decoded = segments.map(safeDecode);

  // Reject before reconstructing: an empty segment means a `//` in the path and
  // a "." or ".." means traversal. Neither can appear in a key we minted.
  if (decoded.some((s) => s === "" || s === "." || s === "..")) {
    return new Response("Not Found", { status: 404 });
  }

  const key = decoded.join("/");

  // Belt and braces: `..` anywhere in the joined key, and the prefix itself.
  if (key.includes("..") || !key.startsWith(KEY_PREFIX)) {
    return new Response("Not Found", { status: 404 });
  }

  let bucket: R2Bucket | undefined;
  try {
    const { env } = await getCloudflareContext({ async: true });
    bucket = env?.PARTS_FILES;
  } catch {
    bucket = undefined;
  }
  if (!bucket) {
    // Plain `next dev` — no binding. The card renders a broken image either
    // way; 503 at least says why in the network tab.
    return new Response("Parts storage is not configured.", { status: 503 });
  }

  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(key);
  } catch (err) {
    console.error("[parts.photo] R2 get failed for", key, err);
    return new Response("Bad Gateway", { status: 502 });
  }
  if (!obj || !obj.body) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  // Echo what the upload route sniffed and stored. The fallback exists only for
  // objects written outside that route (a hand `wrangler r2 object put`);
  // application/octet-stream downloads rather than rendering, which is the
  // safe failure for a file whose type we can't vouch for.
  headers.set(
    "Content-Type",
    obj.httpMetadata?.contentType || "application/octet-stream"
  );
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", CACHE_CONTROL);
  // The bytes are session-gated and served same-origin; never let a browser
  // sniff its way to treating one as a document.
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(obj.body, { status: 200, headers });
}
