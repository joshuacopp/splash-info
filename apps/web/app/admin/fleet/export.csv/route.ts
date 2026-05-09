// Apps/web proxy route handler for the fleet CSV export (Brief 88).
//
// Why this exists:
//   The "Export CSV" button on `/admin/fleet` is the only fleet-admin
//   surface where the BROWSER itself (not the apps/web Worker) initiates
//   the request — `<a href download>` triggers the native download flow
//   so it can save the file to disk. Every other fleet read is SSR'd from
//   apps/web via the `FLEET_INQUIRY_WORKER` service binding.
//
//   Brief 82 chose a subdomain pattern for fleet's staging route
//   (`fleet.staging.splashcarwashes.info`, mirroring production). That
//   means a same-origin relative URL on the CSV button doesn't reach the
//   fleet worker — it resolves to apps/web's hostname instead. Apps/web
//   has no route at `/admin/api/submissions.csv`, so Next renders its 404
//   HTML and Chrome saves it as `submissions.txt` (Brief 88's bug).
//
//   This route handler proxies the request: browser hits apps/web
//   same-origin (cookie + auth all work without any cross-domain
//   negotiation), apps/web binds to fleet via the existing service
//   binding, and the upstream CSV body streams back with the original
//   `Content-Type` + `Content-Disposition` preserved (so the browser
//   still saves with the right filename).
//
// Future workers that pick a subdomain pattern AND need a browser-direct
// download should follow this same proxy convention. JSON read paths
// don't have this problem because they're SSR'd by the apps/web Worker
// itself, never browser-direct.

import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const targetPath = `/admin/api/submissions.csv${incoming.search}`;

  const tryBinding = async (): Promise<Response | null> => {
    try {
      const { env } = await getCloudflareContext({ async: true });
      const binding = env?.FLEET_INQUIRY_WORKER;
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
    const base = process.env.NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL;
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
    return new Response("Fleet worker unavailable", { status: 502 });
  }

  // Pass through status + content headers, but don't blindly forward
  // every response header (Set-Cookie, Server, etc. are not appropriate
  // here). Content-Type + Content-Disposition are what the browser needs
  // to save the download with the right filename + MIME type.
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
