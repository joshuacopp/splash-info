// Server-side calls into splash-forms' site status API
// (apps/forms-worker/src/site-status/admin.ts). Service binding first, URL
// fallback for `next dev` -- the same shape as the other worker-fetch helpers.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { SiteClosureRecord } from "@splash/report-kit/reports/site-closures";

export interface Closure {
  id: string;
  site_number: number;
  site_name: string;
  reason: string;
  reason_detail: string | null;
  closed_at: string;
  closed_by: string;
  original_est_reopen_at: string;
  est_reopen_at: string;
  estimate_changes: Array<{ at: string; by: string; from: string; to: string; note?: string | null }>;
}

export interface DownItem {
  id: string;
  site_number: number;
  item: string;
  note: string | null;
  reported_at: string;
  reported_by: string;
}

export interface BoardSite {
  site_number: number;
  site: string;
  rd_name: string | null;
  rd_email: string | null;
  rm_name: string | null;
  rm_email: string | null;
  can_manage: boolean;
  closure: Closure | null;
  last_closure: {
    closed_at: string;
    reopened_at: string | null;
    reason: string;
    reason_detail: string | null;
    closed_by: string;
  } | null;
  down_items: DownItem[];
}

export interface Board {
  now: string;
  sites: BoardSite[];
  reasons: Array<{ value: string; label: string }>;
  down_item_suggestions: string[];
  can_close_any: boolean;
  is_admin: boolean;
  open_link: string | null;
  test_email_to: string | null;
}

export interface ReportData {
  now: string;
  closures: SiteClosureRecord[];
  sites: Array<{ site_number: number; site: string; rd_name: string | null; rm_name: string | null }>;
}

const BASE = "/forms/admin/api/site-status";

async function workerUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_FORMS_WORKER_URL;
  if (base) return `${base}${path}`;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${path}`;
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Response> {
  const cookieHeader = (await cookies()).toString();
  const build = (url: string) =>
    new Request(url, {
      method: init.method,
      headers: {
        Cookie: cookieHeader,
        Origin: new URL(url).origin,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store"
    });
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.FORMS_WORKER) return await env.FORMS_WORKER.fetch(build(`https://internal${path}`));
  } catch {
    /* next dev: no Workers runtime -- fall through to URL fetch */
  }
  return fetch(build(await workerUrl(path)));
}

export async function getBoard(): Promise<{ data: Board } | { status: number }> {
  const resp = await call(`${BASE}/board`, { method: "GET" });
  if (!resp.ok) return { status: resp.status };
  return { data: (await resp.json()) as Board };
}

export async function getReport(fromIso: string, toIso: string): Promise<{ data: ReportData } | { status: number }> {
  const qs = new URLSearchParams({ from_iso: fromIso, to_iso: toIso });
  const resp = await call(`${BASE}/report?${qs.toString()}`, { method: "GET" });
  if (!resp.ok) return { status: resp.status };
  return { data: (await resp.json()) as ReportData };
}

/** POST; the worker's error is written for the person, so it is shown as-is. */
export async function postSiteStatus(
  path: string,
  body: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await call(`${BASE}${path}`, { method: "POST", body });
  } catch {
    return { ok: false, error: "Could not reach the server. Try again." };
  }
  if (resp.ok) return { ok: true };
  const parsed = (await resp.json().catch(() => ({}))) as { error?: unknown };
  return { ok: false, error: typeof parsed.error === "string" ? parsed.error : `Request failed (${resp.status}).` };
}
