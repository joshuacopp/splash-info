// Proxy for mirrored MaintainX attachment bytes.
//
// WHY A PROXY AT ALL
//
//   The browser cannot reach splash-workorders directly. Production binds only
//   the webhook path on the apex (see apps/workorders-worker/wrangler.toml);
//   /workorders/api/* is still commented for Phase B, and apps/web reaches the
//   worker through the WORKORDERS_WORKER service binding rather than a URL.
//   An <img src> needs a same-origin URL, so this route is it. Same shape as
//   the Brief 88 CSV proxy on fleet.
//
//   It also keeps the R2 bucket bound to exactly one worker. The alternative --
//   binding splash-workorder-files on apps/web too -- is the arrangement that
//   already cost this codebase once, when forms-worker needed PROMO_FILES and
//   the binding step was missed: no error anywhere, just silently missing
//   images. One binding cannot be half-done.
//
// The worker does the permission check. This route forwards the caller's
// cookie and nothing else decides access here; duplicating the check would
// mean two places to get it wrong.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

/** Headers worth passing back. Content-Type and Content-Disposition come from
 *  the stored attachment row; Cache-Control is `private` because the bytes are
 *  scoped to one operator's permissions. */
const FORWARD_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "x-content-type-options"
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return new Response("bad request", { status: 400 });
  }

  const cookieHeader = (await cookies()).toString();
  const path = `/workorders/api/attachment/${id}`;

  let upstream: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as unknown as { WORKORDERS_WORKER?: Fetcher }).WORKORDERS_WORKER;
    if (!binding) throw new Error("WORKORDERS_WORKER binding unavailable");
    upstream = await binding.fetch(
      // Service bindings ignore the host; only the path matters.
      new Request(`https://internal${path}`, { headers: { Cookie: cookieHeader } })
    );
  } catch {
    // `next dev` runs outside the Workers runtime, so the binding is absent.
    // Same fallback shape as every other worker-fetch helper here.
    const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
    if (!base) return new Response("unavailable", { status: 503 });
    upstream = await fetch(`${base}${path}`, { headers: { Cookie: cookieHeader } });
  }

  if (!upstream.ok || !upstream.body) {
    // Pass the status through rather than flattening it. The worker answers
    // 404 for both "no such attachment" and "not yours" on purpose, and
    // re-mapping it here would undo that.
    return new Response(null, { status: upstream.status });
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers });
}
