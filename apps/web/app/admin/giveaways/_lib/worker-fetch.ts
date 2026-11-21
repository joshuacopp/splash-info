// Server-side calls into splash-forms' giveaways API
// (apps/forms-worker/src/giveaways/admin.ts). Service binding first, URL
// fallback for `next dev` -- the same shape as the other worker-fetch helpers.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { GiveawayFields, GiveawaySmsConsent } from "@splash/forms-schema/giveaway";
import type { GiveawayEntryRow } from "@splash/report-kit/reports/giveaway-entries";

export type GiveawayState = "open" | "not_started" | "ended" | "archived";

export interface GiveawaySummary {
  id: string;
  title: string;
  prize: string | null;
  starts_on: string | null;
  ends_on: string | null;
  fields: GiveawayFields;
  sms_consent: GiveawaySmsConsent;
  one_per_person: boolean;
  archived_at: string | null;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
  link_path: string;
  state: GiveawayState;
  entry_count: number;
  sms_count: number;
}

export interface GiveawayList {
  today: string;
  giveaways: GiveawaySummary[];
}

export interface GiveawayDetail {
  today: string;
  giveaway: GiveawaySummary;
  entries: GiveawayEntryRow[];
  entries_capped: boolean;
}

const BASE = "/forms/admin/api/giveaways";

async function workerUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_FORMS_WORKER_URL;
  if (base) return `${base}${path}`;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${path}`;
}

async function call(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Response> {
  const cookieHeader = (await cookies()).toString();
  const build = (url: string) =>
    new Request(url, {
      method,
      headers: {
        Cookie: cookieHeader,
        Origin: new URL(url).origin,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

export async function listGiveaways(): Promise<{ data: GiveawayList } | { status: number; error?: string }> {
  const resp = await call(BASE, "GET");
  if (!resp.ok) {
    const e = (await resp.json().catch(() => ({}))) as { error?: unknown };
    return { status: resp.status, error: typeof e.error === "string" ? e.error : undefined };
  }
  return { data: (await resp.json()) as GiveawayList };
}

export async function getGiveaway(id: string): Promise<{ data: GiveawayDetail } | { status: number; error?: string }> {
  const resp = await call(`${BASE}/${encodeURIComponent(id)}`, "GET");
  if (!resp.ok) {
    const e = (await resp.json().catch(() => ({}))) as { error?: unknown };
    return { status: resp.status, error: typeof e.error === "string" ? e.error : undefined };
  }
  return { data: (await resp.json()) as GiveawayDetail };
}

/** A write; the worker's error is written for the person, so it is shown as-is. */
export async function writeGiveaway(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await call(`${BASE}${path}`, method, body);
  } catch {
    return { ok: false, error: "Could not reach the server. Try again." };
  }
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.ok) return { ok: true, data: parsed };
  return { ok: false, error: typeof parsed.error === "string" ? parsed.error : `Request failed (${resp.status}).` };
}
