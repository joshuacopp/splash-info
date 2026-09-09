// Same-origin proxy for the weekly digest preview (/admin/greeters/digest-preview).
//
// Why this exists rather than opening /pertrack/api/greeter/digest/preview
// directly: performance-worker is only route-bound on staging (see
// apps/performance-worker/wrangler.toml — the apex line is commented out and
// marked ROLLED BACK). Server-rendered reads still work on the apex because
// apps/web calls the worker over the PERFORMANCE_WORKER service binding, but a
// *browser* request to a relative /pertrack/... URL has nothing to route to and
// 404s. The preview is a browser request by definition, so it comes through here.
//
// Same pattern and the same reason as ./roster/route.ts.
//
// PASSES THE HTML STRAIGHT THROUGH, which is why it uses performanceGetRaw
// rather than performanceGetJson: the body is a rendered email, and the helper
// that parses JSON and collapses 401/403 to null would destroy both the bytes
// and the status. The worker's own super_admin gate is the authorization here —
// this file adds no check of its own, exactly as roster/route.ts doesn't.
//
// Query parameters are forwarded rather than passed on wholesale, so nothing
// unexpected reaches the worker: ?email= picks the recipient, ?week= (any date
// inside the week) picks which week.

import { performanceGetRaw } from "../../performance/_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const src = new URL(req.url);
  const qs = new URLSearchParams();
  const email = src.searchParams.get("email");
  if (email) qs.set("email", email);
  const week = src.searchParams.get("week");
  if (week) qs.set("week", week);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  try {
    const upstream = await performanceGetRaw(
      `/pertrack/api/greeter/digest/preview${suffix}`
    );
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
        // A preview of last week's numbers cached into next week would be a
        // quietly wrong answer, which is the worst kind for this page.
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "preview failed" },
      { status: 502 }
    );
  }
}
