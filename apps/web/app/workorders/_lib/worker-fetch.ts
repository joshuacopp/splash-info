// Brief 70 + Brief 71 — server-side fetch helper for the workorders-worker.
// Mirrors the dual-mode (service-binding preferred, URL fallback for
// `next dev`) pattern from `apps/web/app/admin/damage/_lib/worker-fetch.ts`.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/* ============================================================
 * Response shape — matches workorders-worker's
 * `GET /workorders/api/list` JSON (Brief 71 shape).
 * ============================================================ */

export interface WorkOrderAssignee {
  id: number | null;
  type: "USER" | "TEAM" | "OTHER";
  name: string;
  email: string | null;
}

export interface WorkOrderItem {
  id: number;
  sequentialId: number | null;
  title: string;
  status: string;
  priority: string;
  type: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dueDate: string | null;
  description: string | null;
  assignees: WorkOrderAssignee[];
  categories: string[];
  locationId: number | null;
}

export interface WorkOrdersGroup {
  maintainx_id: number;
  location_pretty: string;
  work_orders: WorkOrderItem[];
}

export interface WorkOrdersBucket {
  groups: WorkOrdersGroup[];
}

/** Brief 74 — surfaced to apps/web alongside the read response so the
 *  New Request tab's Location dropdown has data without a second fetch.
 *  The form filters to entries with `maintainx_id !== null` (a request
 *  can't post to an unmapped location). */
export interface AccessibleLocation {
  maintainx_id: number | null;
  location_address: string | null;
  location_name: string | null;
}

export interface WorkOrdersCurrentUser {
  email: string;
  full_name: string | null;
}

export interface WorkOrdersListResponse {
  reactive: WorkOrdersBucket;
  preventive: WorkOrdersBucket;
  fetchedAt: string;
  truncated: boolean;
  /** Brief 72: number of MaintainX API calls made by the worker for
   *  this response (1 for single-location users, 1-5 for multi-location). */
  pageCount: number;
  accessibleLocationCount: number;
  mappedLocationCount: number;
  email: string;
  /** Brief 74 additions — populated for the New Request tab. */
  accessibleLocations: AccessibleLocation[];
  currentUser: WorkOrdersCurrentUser;
}

export type WorkOrdersListResult =
  | { kind: "ok"; data: WorkOrdersListResponse }
  | { kind: "denied" } // 401 or 403
  | { kind: "not_configured" } // 503 (MAINTAINX_API_KEY unbound)
  | { kind: "error"; status: number; message: string };

/**
 * Build an absolute URL for a workorders-worker call. Used for the
 * URL-based dev fallback only; production uses the service binding.
 */
async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL;
  if (base) {
    return `${base}${trimmed}`;
  }
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

async function workOrdersGetResponse(path: string): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.WORKORDERS_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const req = new Request(`https://internal${trimmed}`, {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      return env.WORKORDERS_WORKER.fetch(req);
    }
  } catch {
    // Fall through to URL-based fetch (next dev / non-Workers runtime).
  }

  const url = await workerUrl(path);
  return fetch(url, {
    method: "GET",
    headers: { Cookie: cookieHeader },
    cache: "no-store"
  });
}

export async function fetchWorkOrdersList(): Promise<WorkOrdersListResult> {
  const resp = await workOrdersGetResponse("/workorders/api/list");
  if (resp.status === 401 || resp.status === 403) return { kind: "denied" };
  if (resp.status === 503) return { kind: "not_configured" };
  if (!resp.ok) {
    let message = `Worker GET /workorders/api/list failed: ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) message = body.error;
    } catch {
      // ignore
    }
    return { kind: "error", status: resp.status, message };
  }
  const data = (await resp.json()) as WorkOrdersListResponse;
  return { kind: "ok", data };
}
