// Shared body of the two IT-issue photo routes: the signed-in one forwards the
// session cookie, the email-link one deliberately does not (the token in the
// path is its only authority). Both stream the worker's bytes back with only
// the headers worth keeping -- type, length, nosniff, private caching.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

const FORWARD = ["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options"];
const FILE_RE = /^[0-9a-f-]{36}\.(jpg|png|gif|webp|heic)$/;

export async function proxyPhoto(workerPath: string, file: string, withSession: boolean): Promise<Response> {
  if (!FILE_RE.test(file)) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = withSession ? { Cookie: (await cookies()).toString() } : {};

  let upstream: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (!env.WORKORDERS_WORKER) throw new Error("WORKORDERS_WORKER binding unavailable");
    upstream = await env.WORKORDERS_WORKER.fetch(new Request(`https://internal${workerPath}`, { headers }));
  } catch {
    const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
    if (!base) return new Response("unavailable", { status: 503 });
    upstream = await fetch(`${base}${workerPath}`, { headers });
  }

  if (!upstream.ok || !upstream.body) return new Response(null, { status: upstream.status });
  const out = new Headers();
  for (const name of FORWARD) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(upstream.body, { status: 200, headers: out });
}
