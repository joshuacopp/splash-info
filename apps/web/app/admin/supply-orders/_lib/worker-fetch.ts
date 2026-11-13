// Supply Orders -- server-side calls into splash-workorders
// (/workorders/api/supply-orders*). Service binding first, URL fallback for
// `next dev` (Brief 17 pattern).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Meta, OrderDetail, OrderListItem } from "./types";

async function fallbackUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
  if (base) return `${base}${path}`;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost:3000"}${path}`;
}

export async function soFetch(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const h: Record<string, string> = { Cookie: (await cookies()).toString() };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const init = (origin: string): RequestInit => ({
    method,
    // The worker's isOriginAllowed compares against the URL it was called on.
    headers: method === "POST" ? { ...h, Origin: origin } : h,
    body: body === undefined ? undefined : JSON.stringify(body)
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

async function readJson<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function getMeta(): Promise<Meta | null> {
  return readJson<Meta>(await soFetch("GET", "/workorders/api/supply-orders/meta"));
}

export async function listOrders(status: "open" | "all"): Promise<{ orders: OrderListItem[]; can_order: boolean } | null> {
  return readJson(await soFetch("GET", `/workorders/api/supply-orders?status=${status}`));
}

export async function getOrderDetail(id: string): Promise<OrderDetail | null> {
  return readJson<OrderDetail>(await soFetch("GET", `/workorders/api/supply-orders/${encodeURIComponent(id)}`));
}

/** POST and turn the worker's answer into { ok, data } / { ok:false, error }. */
export async function soPost<T = unknown>(
  path: string,
  body: unknown
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await soFetch("POST", path, body);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: parsed?.error ?? `Request failed (${res.status}).` };
  return { ok: true, data: parsed as T };
}

/** Pass a worker response straight back to the browser (route handlers). */
export async function relay(res: Response): Promise<Response> {
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
