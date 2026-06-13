// Apps/web proxy route handler for the damage-claims CSV export (Brief 172).
//
// Why this exists:
//   The "Export CSV" button on `/admin/damage` is a browser-initiated
//   download (`<a href download>`). The damage worker isn't bound on
//   apps/web's hostname for `/admin/damage/export.csv`, so a relative URL
//   pointing straight at the worker wouldn't reach it from the browser.
//   This route handler keeps the browser same-origin and proxies via the
//   `DAMAGE_WORKER` service binding internally — cookies + auth flow
//   transparently, no cross-origin work.
//
// Pattern is a copy of `apps/web/app/admin/fleet/export.csv/route.ts`
// (Brief 88) — same shape, same headers passed through, same fallback
// for `next dev`.
//
// Note: this route lives at `/admin/damage/export.csv` so it's NATURALLY
// gated by the apps/web middleware's `/admin/*` cookie check. The damage
// worker re-authenticates + re-scopes dc_role on its side as defense in
// depth.

import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const targetPath = `/manage/api/claims.csv${incoming.search}`;

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

  // Pass through status + the two content headers the browser needs to
  // save the download. Don't blindly forward Set-Cookie / Server / etc.
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
