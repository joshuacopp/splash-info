// IT Issue Tracker -- server-side calls into splash-workorders
// (/workorders/api/it-issues*, /workorders/api/it-issue-link/*). Service
// binding first, URL fallback for `next dev` (Brief 17 pattern).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { IssueDetail, IssueList, PublicIssue } from "./types";

async function fallbackUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
  if (base) return `${base}${path}`;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost:3000"}${path}`;
}

/**
 * One call into the worker. `withSession: false` is for the public email-link
 * page, which must NOT forward a signed-in visitor's cookie -- the token is the
 * only authority there.
 */
export async function itFetch(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  withSession = true
): Promise<Response> {
  const h: Record<string, string> = {};
  if (withSession) h.Cookie = (await cookies()).toString();
  // FormData sets its own multipart boundary header; anything else is JSON.
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) h["Content-Type"] = "application/json";
  const init = (origin: string): RequestInit => ({
    method,
    // The worker's isOriginAllowed compares against the URL it was called on.
    headers: method === "POST" ? { ...h, Origin: origin } : h,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
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

export async function listIssues(qs: URLSearchParams): Promise<IssueList | null> {
  const q = qs.toString();
  return readJson<IssueList>(await itFetch("GET", `/workorders/api/it-issues${q ? `?${q}` : ""}`));
}

export async function getIssueDetail(id: string): Promise<IssueDetail | null> {
  return readJson<IssueDetail>(await itFetch("GET", `/workorders/api/it-issues/${encodeURIComponent(id)}`));
}

export async function getPublicIssue(token: string): Promise<PublicIssue | null> {
  return readJson<PublicIssue>(
    await itFetch("GET", `/workorders/api/it-issue-link/${encodeURIComponent(token)}`, undefined, false)
  );
}

/** POST and turn the worker's answer into { ok, data } / { ok:false, error }. */
export async function itPost<T = unknown>(
  path: string,
  body: unknown,
  withSession = true
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await itFetch("POST", path, body, withSession);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: parsed?.error ?? `Request failed (${res.status}).` };
  return { ok: true, data: parsed as T };
}
