// Streams a parts manual's HTML out of R2 (/admin/parts/{slug}/file).
//
// This is the iframe's src. It exists instead of a public/ static asset so the
// bytes sit behind middleware's /admin/* cookie gate — Cloudflare serves the
// [assets] binding before the worker runs, so anything in public/ is reachable
// without a session no matter what middleware says.
//
// The slug is resolved through the manifest rather than being used as an R2
// key directly, so a request can only ever reach an object somebody listed.
//
// CSP: the manuals are self-contained (inline <script>/<style>, images as
// base64 data: URIs, zero network calls — verified against both files at
// import time). Serving operator-uploaded HTML same-origin with the session
// cookie in scope is the one sharp edge here, so the policy denies everything
// the manuals demonstrably don't use — in particular connect-src, which is
// what a tampered upload would need to exfiltrate anything it scraped.

import { findManual, PartsBindingUnavailable } from "../../_lib/manuals";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "font-src data:",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await ctx.params;

  let manual;
  try {
    manual = await findManual(slug);
  } catch (err) {
    if (err instanceof PartsBindingUnavailable) {
      return new Response("Parts storage is not configured.", { status: 503 });
    }
    throw err;
  }
  if (!manual) return new Response("Not Found", { status: 404 });

  const { env } = await getCloudflareContext({ async: true });

  // Conditional GET: these files are multi-MB, and a viewer who reopens a
  // manual should get a 304 rather than the body again.
  //
  // R2's etagDoesNotMatch wants the BARE etag and throws on anything quoted,
  // but If-None-Match carries it quoted, optionally weak-prefixed, and
  // potentially as a list — so unwrap the first entry. "*" means "if any
  // representation exists", which isn't a comparison R2 can take; fall
  // through to a full body for it.
  const inm = req.headers.get("If-None-Match");
  const clientEtag = inm
    ?.split(",")[0]
    ?.trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");

  const obj = await env.PARTS_FILES.get(manual.key, {
    onlyIf:
      clientEtag && clientEtag !== "*"
        ? { etagDoesNotMatch: clientEtag }
        : undefined
  });
  if (!obj) return new Response("Not Found", { status: 404 });

  // Deliberately not obj.writeHttpMetadata(): every header it would copy off
  // the upload is one we override below, and forcing the content type here
  // means a manual uploaded without --content-type still renders instead of
  // downloading.
  const headers = new Headers();
  headers.set("ETag", obj.httpEtag);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  // Private: the response is session-gated, so only the browser may keep it.
  // must-revalidate + the ETag above means a replaced upload is picked up on
  // the next view instead of going stale behind a long max-age.
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");

  // R2 signals "your etag matched" by returning an object with no body.
  if (!("body" in obj) || obj.body === null) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
