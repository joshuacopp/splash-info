// Price Match -- server-side calls into splash-workorders
// (/workorders/api/price-match*). Service binding first, URL fallback for
// `next dev` (Brief 17 pattern). The browser never calls the worker directly:
// /workorders/api/* is not routed on the apex domain.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface PriceMatchHistoryItem {
  id: string;
  ref_no: number;
  created_at: string;
  created_by_email: string;
  competitor: string;
  lines: Array<{ part: string }>;
  files: Array<{ filename: string }>;
  sent_to: string;
  sent_cc: string[];
  test: boolean;
}

export interface PriceMatchOverview {
  live: boolean;
  to: string;
  cc: string[];
  live_recipients: string[];
  requests: PriceMatchHistoryItem[];
}

async function fallbackUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
  if (base) return `${base}${path}`;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost:3000"}${path}`;
}

/** Forward a request to the worker. `body` is passed through untouched (raw
 *  multipart included) with the caller's Content-Type. */
export async function pmFetch(
  method: "GET" | "POST",
  path: string,
  body?: BodyInit,
  contentType?: string
): Promise<Response> {
  const h: Record<string, string> = { Cookie: (await cookies()).toString() };
  if (contentType) h["Content-Type"] = contentType;
  const init = (origin: string): RequestInit => ({
    method,
    // The worker's isOriginAllowed compares against the URL it was called on.
    headers: method === "POST" ? { ...h, Origin: origin } : h,
    body
  });
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.WORKORDERS_WORKER) {
      return env.WORKORDERS_WORKER.fetch(new Request(`https://internal${path}`, init("https://internal")));
    }
  } catch {
    // next dev: no Cloudflare context -- fall through to the URL path.
  }
  const url = await fallbackUrl(path);
  return fetch(url, { ...init(new URL(url).origin), cache: "no-store" });
}

export async function getOverview(): Promise<PriceMatchOverview | null> {
  const res = await pmFetch("GET", "/workorders/api/price-match");
  return res.ok ? ((await res.json()) as PriceMatchOverview) : null;
}

/** Pass a worker response straight back to the browser (route handlers). */
export async function relay(res: Response): Promise<Response> {
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
