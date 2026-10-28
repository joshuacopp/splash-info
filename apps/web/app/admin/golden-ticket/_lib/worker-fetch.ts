// Server-side calls into the jotform-worker's Golden Ticket API
// (apps/jotform-worker/src/golden-ticket/admin.js). Service binding first,
// URL fallback for `next dev` -- same shape as ../../jotform/_lib/worker-fetch.ts.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export type WinStatus = "new" | "in_progress" | "done" | "void";

export interface HistoryEntry {
  at: string;
  by: string | null;
  changes: Record<string, [unknown, unknown]>;
  note?: string;
}

export interface DuplicateRef {
  submission_id: string;
  won_on: string;
  site_name: string | null;
  site_number: string | null;
  prize_code: string | null;
  customer_name: string | null;
  photo_url: string | null;
  status: WinStatus;
}

export interface GoldenTicketWin {
  submission_id: string;
  form_id: string;
  site_number: string | null;
  site_name: string | null;
  submitted_at: string;
  won_on: string;
  customer_name: string | null;
  phone: string | null;
  plate: string | null;
  plate_norm: string;
  barcode: string | null;
  existing_unlimited: string | null;
  prize: string | null;
  prize_code: string | null;
  ticket_serial: string | null;
  employee_name: string | null;
  photo_url: string | null;
  promo_id: string | null;
  promo_name: string | null;
  status: WinStatus;
  account_setup: boolean;
  micrologic_tagged: boolean;
  history: HistoryEntry[];
  crd_updated_at: string | null;
  crd_updated_by: string | null;
  dup_count: number;
  duplicates: DuplicateRef[];
}

export interface GoldenTicketPromo {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  updated_at: string;
  updated_by: string | null;
}

export interface WinsResponse {
  wins: GoldenTicketWin[];
  counts: Record<"mine" | "team" | "open" | "new" | "in_progress" | "done" | "void" | "all" | "duplicates", number>;
  cap_reached: boolean;
  promos: GoldenTicketPromo[];
  promo: string;
  current_promo_id: string | null;
  status: string;
  can_admin: boolean;
  /** Caller is the CRD agent (crd_site_coverage.crd_email) for at least one site. */
  is_agent: boolean;
  /** Caller supervises at least one CRD region (crd_regions.supervisor_email). */
  is_supervisor: boolean;
  lookup_path: string | null;
}

async function workerUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_JOTFORM_WORKER_URL;
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
    if (env.JOTFORM_WORKER) return await env.JOTFORM_WORKER.fetch(build(`https://internal${path}`));
  } catch {
    /* next dev: no Workers runtime -- fall through to URL fetch */
  }
  return fetch(build(await workerUrl(path)));
}

/** GET the queue. `{status}` on 401/403 so the page can say which. */
export async function getWins(
  params: { promo?: string; status?: string; q?: string }
): Promise<{ data: WinsResponse } | { status: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const resp = await call(`/admin/jotform/api/golden-ticket/wins?${qs.toString()}`, { method: "GET" });
  if (!resp.ok) return { status: resp.status };
  return { data: (await resp.json()) as WinsResponse };
}

/** POST; returns the worker's error sentence on failure (it is written for
 *  the operator, so it goes into the banner verbatim). */
export async function postGoldenTicket(
  path: string,
  body: unknown
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await call(`/admin/jotform/api/golden-ticket/${path}`, { method: "POST", body });
  } catch {
    return { ok: false, error: "Could not reach the server. Try again." };
  }
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const msg = typeof parsed.error === "string" ? parsed.error : `Request failed (${resp.status}).`;
    return { ok: false, error: msg };
  }
  return { ok: true, body: parsed };
}
