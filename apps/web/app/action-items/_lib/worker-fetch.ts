// SSR + server-action calls into splash-forms for action items.
// Service-binding-first with a URL fallback for `next dev` (Brief 17 pattern).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import type {
  ActionItem,
  ActionItemNote,
  ActionItemsResponse
} from "./types";

const FORMS_BINDING = "FORMS_WORKER" as const;

/** Mirrors the fallback in admin/forms/_lib/worker-fetch.ts: env var when set
 *  (cross-origin dev), else the request host, which is same-origin in
 *  production because forms is path-carved on splashcarwashes.info/forms/*. */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_FORMS_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

interface CallOptions {
  method?: string;
  jsonBody?: unknown;
}

async function callForms(path: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const cookieStore = await cookies();
  const headers = new Headers();
  headers.set("Cookie", cookieStore.toString());

  const init: RequestInit = { method };
  if (opts.jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(opts.jsonBody);
  }

  try {
    const { env } = await getCloudflareContext({ async: true });
    // FORMS_WORKER is declared on CloudflareEnv in cloudflare-env.d.ts, so
    // index it directly rather than casting through Record<string, unknown>.
    const binding = env[FORMS_BINDING];
    if (binding) {
      const internalUrl = `https://internal${path}`;
      // The worker's isOriginAllowed CSRF gate needs this on writes.
      if (method !== "GET") headers.set("Origin", new URL(internalUrl).origin);
      return await binding.fetch(new Request(internalUrl, { ...init, headers }));
    }
  } catch {
    // fall through to the URL path (next dev)
  }

  const url = await workerUrl(path);
  if (method !== "GET") headers.set("Origin", new URL(url).origin);
  return await fetch(url, { ...init, headers, cache: "no-store" });
}

/** Null means the worker refused — no accessible locations, or not signed in.
 *  Distinct from an empty `items` array, which means "you have access and
 *  there is nothing to do". */
export async function listActionItems(params?: {
  location?: string;
  status?: string;
  submissionId?: string;
}): Promise<ActionItemsResponse | null> {
  const qs = new URLSearchParams();
  if (params?.location) qs.set("location", params.location);
  if (params?.status) qs.set("status", params.status);
  if (params?.submissionId) qs.set("submission_id", params.submissionId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const resp = await callForms(`/forms/api/action-items${suffix}`);
  if (!resp.ok) return null;
  return (await resp.json()) as ActionItemsResponse;
}

export async function patchActionItem(
  id: string,
  patch: Partial<Pick<ActionItem, "status" | "description" | "priority" | "due_date">>
): Promise<{ ok: true; item: ActionItem } | { ok: false; error: string }> {
  const resp = await callForms(`/forms/api/action-items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    jsonBody: patch
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status}${text ? ` — ${text}` : ""}` };
  }
  return (await resp.json()) as { ok: true; item: ActionItem };
}

export async function verifyActionItem(
  id: string
): Promise<{ ok: true; item: ActionItem } | { ok: false; error: string }> {
  const resp = await callForms(
    `/forms/api/action-items/${encodeURIComponent(id)}/verify`,
    { method: "POST" }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status}${text ? ` — ${text}` : ""}` };
  }
  return (await resp.json()) as { ok: true; item: ActionItem };
}

export async function listActionItemNotes(
  id: string
): Promise<ActionItemNote[]> {
  const resp = await callForms(
    `/forms/api/action-items/${encodeURIComponent(id)}/notes`
  );
  // Fail-soft to an empty thread: losing the notes must not cost the whole
  // page, and an item with no visible notes still shows its own state.
  if (!resp.ok) return [];
  const body = (await resp.json().catch(() => ({ notes: [] }))) as {
    notes?: ActionItemNote[];
  };
  return Array.isArray(body.notes) ? body.notes : [];
}

export async function createActionItemNote(
  id: string,
  body: string
): Promise<{ ok: true; note: ActionItemNote } | { ok: false; error: string }> {
  const resp = await callForms(
    `/forms/api/action-items/${encodeURIComponent(id)}/notes`,
    { method: "POST", jsonBody: { body } }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status}${text ? ` — ${text}` : ""}` };
  }
  return (await resp.json()) as { ok: true; note: ActionItemNote };
}

export async function createActionItem(input: {
  location_code: string;
  description: string;
  priority?: string;
  due_date?: string | null;
}): Promise<{ ok: true; item: ActionItem } | { ok: false; error: string }> {
  const resp = await callForms("/forms/api/action-items", {
    method: "POST",
    jsonBody: input
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status}${text ? ` — ${text}` : ""}` };
  }
  return (await resp.json()) as { ok: true; item: ActionItem };
}
