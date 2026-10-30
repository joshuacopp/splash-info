// Same-origin proxy for the Golden Ticket Excel export.
//
// The browser downloads from /admin/golden-ticket/export.xlsx so the admin
// cookie flows and the /admin/* middleware gate applies; this hands the
// request to the jotform-worker (`GET /admin/jotform/api/golden-ticket/
// wins.xlsx`, same query string as the page) over the service binding and
// streams the file back. The worker owns access and filtering -- see
// apps/jotform-worker/src/golden-ticket/admin.js. Same shape as
// ../../damage/export.xlsx/route.ts.

import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const cookieHeader = (await cookies()).toString();
  const targetPath = `/admin/jotform/api/golden-ticket/wins.xlsx${incoming.search}`;

  const build = (url: string) =>
    new Request(url, {
      method: "GET",
      headers: { Cookie: cookieHeader, Origin: new URL(url).origin }
    });

  let upstream: Response | null = null;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env?.JOTFORM_WORKER) upstream = await env.JOTFORM_WORKER.fetch(build(`https://internal${targetPath}`));
  } catch {
    /* next dev: no Workers runtime -- fall through to URL fetch */
  }
  if (!upstream) {
    const base = process.env.NEXT_PUBLIC_JOTFORM_WORKER_URL;
    if (base) upstream = await fetch(build(`${base}${targetPath}`), { cache: "no-store" });
  }
  if (!upstream) return new Response("JotForm worker unavailable", { status: 502 });

  const headers = new Headers({ "Cache-Control": "no-store" });
  const ct = upstream.headers.get("Content-Type");
  const cd = upstream.headers.get("Content-Disposition");
  if (ct) headers.set("Content-Type", ct);
  if (cd) headers.set("Content-Disposition", cd);
  return new Response(upstream.body, { status: upstream.status, headers });
}
