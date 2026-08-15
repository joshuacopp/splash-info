// Same-origin proxy for the greeter roster lookup (/admin/greeters/roster).
//
// Why this exists rather than the client fetching /pertrack/api/greeter/roster
// directly: performance-worker is only route-bound on staging (see
// apps/performance-worker/wrangler.toml — the apex line is commented out and
// marked ROLLED BACK). Server-rendered reads still work because apps/web calls
// the worker over the PERFORMANCE_WORKER service binding, but a *browser* fetch
// on a relative /pertrack/... URL has nothing to route to on the apex and 404s.
// The roster dropdown is a browser fetch, so it goes through here instead.
//
// Same pattern as admin/damage/export.csv/route.ts (Brief 172). Living under
// /admin/* also means the apps/web middleware cookie check gates it; the worker
// re-authenticates and re-scopes on its side regardless.

import { performanceGetJson } from "../../performance/_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const locationId = new URL(req.url).searchParams.get("location_id") ?? "";
  if (!/^\d+$/.test(locationId)) {
    return Response.json({ error: "location_id is required" }, { status: 400 });
  }

  try {
    const roster = await performanceGetJson<unknown>(
      `/pertrack/api/greeter/roster?location_id=${locationId}`
    );
    // performanceGetJson collapses 401/403 to null — the client renders that as
    // "you don't have access to this location's roster".
    if (roster === null) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return Response.json(roster);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "roster lookup failed" },
      { status: 502 }
    );
  }
}
