// SSR + server-action calls into splash-forms for the SDS binder index.
//
// Transport is copied from the action-items helper next door rather than
// imported: both are thin wrappers over the same binding, and sharing one
// would couple two unrelated features' error handling for the sake of thirty
// lines. If a third appears, promote it.
// Service-binding-first with a URL fallback for `next dev` (Brief 17 pattern).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { SdsCandidate, SdsItem, SdsResponse } from "./types";

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

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function unwrap<T>(resp: Response): Promise<Result<T>> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status}${text ? ` — ${text}` : ""}` };
  }
  return { ok: true, data: (await resp.json()) as T };
}

/** Null means the worker refused -- not signed in, or no site contact match
 *  anywhere. Distinct from an empty `items` array, which means "you have access
 *  and this site has nothing listed yet". */
export async function listSds(params?: {
  location?: string;
  includeInactive?: boolean;
}): Promise<SdsResponse | null> {
  const qs = new URLSearchParams();
  if (params?.location) qs.set("location", params.location);
  if (params?.includeInactive) qs.set("include_inactive", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const resp = await callForms(`/forms/api/sds${suffix}`);
  if (!resp.ok) return null;
  return (await resp.json()) as SdsResponse;
}

export async function listSdsCandidates(
  location: string
): Promise<SdsCandidate[]> {
  const resp = await callForms(
    `/forms/api/sds/candidates?location=${encodeURIComponent(location)}`
  );
  // Fail-soft to empty: the seeding picker is a convenience, and a site with no
  // inventory rows looks identical to one the lookup failed for. Neither should
  // block adding a chemical by hand.
  if (!resp.ok) return [];
  const data = (await resp.json()) as { candidates?: SdsCandidate[] };
  return data.candidates ?? [];
}

export async function createSdsItem(input: {
  location_code: string;
  product_identifier: string;
  manufacturer?: string | null;
  work_area?: string | null;
  binder_tab?: string | null;
}): Promise<Result<{ item: SdsItem }>> {
  return unwrap(await callForms("/forms/api/sds", { method: "POST", jsonBody: input }));
}

/**
 * Edit one listed chemical.
 *
 * The patch shape is DELIBERATELY FLAT even though the worker splits it in two:
 * site fields go to the site row, and identity fields (name, manufacturer,
 * source URL, revision date) go to the shared catalogue row and change every
 * site holding that chemical. Callers should not have to know which is which --
 * the worker does, and it is the only place that should.
 */
export async function patchSdsItem(
  id: string,
  patch: {
    work_area?: string | null;
    binder_tab?: string | null;
    is_active?: boolean;
    sort_order?: number;
    product_identifier?: string;
    manufacturer?: string | null;
    source_url?: string | null;
    sds_revision_date?: string | null;
  }
): Promise<Result<{ item: SdsItem }>> {
  return unwrap(
    await callForms(`/forms/api/sds/${encodeURIComponent(id)}`, {
      method: "PATCH",
      jsonBody: patch
    })
  );
}

export async function seedSdsFromInventory(
  location_code: string,
  product_ids: string[]
): Promise<Result<{ items: SdsItem[]; created: number; requested: number }>> {
  return unwrap(
    await callForms("/forms/api/sds/seed", {
      method: "POST",
      jsonBody: { location_code, product_ids }
    })
  );
}

export async function markSdsReviewed(
  location_code: string
): Promise<Result<{ review: { last_reviewed_at: string } }>> {
  return unwrap(
    await callForms("/forms/api/sds/review", {
      method: "POST",
      jsonBody: { location_code }
    })
  );
}
