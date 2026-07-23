// Apps/web proxy route handler for the damage-claims XLSX export (Brief 178).
//
// Exact twin of ./export.csv/route.ts — same service-binding proxy, same
// same-origin download behavior, same `next dev` fallback. The only
// difference is the upstream path (`claims.xlsx`) and that the passed-
// through Content-Type is the spreadsheet MIME the worker sets. The
// worker owns all auth/scope; this keeps the browser same-origin so the
// admin cookie flows and the `/admin/*` middleware gate applies.
//
// See export.csv/route.ts for the fuller rationale — kept intentionally
// identical so the two exports never diverge in transport behavior.

import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const targetPath = `/manage/api/claims.xlsx${incoming.search}`;

  const tryBinding = async (): Promise<Response | null> => {
    try {
      const { env } = await getCloudflareContext({ async: true });
      const binding = env?.DAMAGE_WORKER;
      if (!binding) return null;
      const url = `https://internal${targetPath}`;
      const upstreamReq = new Request(url, {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
          Origin: new URL(url).origin
        }
      });
      return await binding.fetch(upstreamReq);
    } catch {
      return null;
    }
  };

  const tryUrlFallback = async (): Promise<Response | null> => {
    const base = process.env.NEXT_PUBLIC_DAMAGE_WORKER_URL;
    if (!base) return null;
    const url = `${base}${targetPath}`;
    return await fetch(url, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        Origin: new URL(url).origin
      },
      cache: "no-store"
    });
  };

  const upstream = (await tryBinding()) ?? (await tryUrlFallback());
  if (!upstream) {
    return new Response("Damage worker unavailable", { status: 502 });
  }

  const headers = new Headers();
  const ct = upstream.headers.get("Content-Type");
  const cd = upstream.headers.get("Content-Disposition");
  if (ct) headers.set("Content-Type", ct);
  if (cd) headers.set("Content-Disposition", cd);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
}
