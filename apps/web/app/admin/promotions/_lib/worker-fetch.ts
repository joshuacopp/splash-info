// Brief 158a — Server-side fetch helpers for the splash-promo worker.
// Brief 158b — extended with the write helpers consumed by server
// actions (create / status / ticket / assignees / location progress /
// materials / PTP / announcement).
//
// Mirrors apps/web/app/admin/forms/_lib/worker-fetch.ts (Brief 94/96) and
// apps/web/app/admin/jotform/_lib/worker-fetch.ts (Brief 109) — service-
// binding-first via `getCloudflareContext({ async: true })`, URL fallback
// for `next dev` outside the Workers runtime.
//
// Bindings live in apps/web/wrangler.toml (`PROMO_WORKER`, declared as the
// 9th [[services]] block in Brief 153); the dev fallback URL comes from
// `NEXT_PUBLIC_PROMO_WORKER_URL` when set, otherwise the request host
// (apps/web staging is on the same zone via next.config.mjs rewrites —
// `splash-promo` is path-carved under `/promo/*` per Brief 153).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type {
  PromoDetail,
  PromoDetailResponse,
  PromoListResponse,
  PromoPriority,
  PromoStatus,
  PromoType
} from "./types";

const PROMO_BINDING = "PROMO_WORKER" as const;

async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_PROMO_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

interface CallOptions {
  method?: string;
  jsonBody?: unknown;
  formData?: FormData;
}

/**
 * Internal dispatcher used by every read + write helper below. Service-
 * binding-first, URL fallback for next dev. Cookie + Origin headers
 * always forwarded so the worker's `isOriginAllowed` CSRF gate passes
 * from both apps/web SSR and from dev cross-origin.
 */
async function callPromo(path: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const reqInit: RequestInit = { method };
  const reqHeaders = new Headers();
  reqHeaders.set("Cookie", cookieHeader);

  if (opts.jsonBody !== undefined) {
    reqHeaders.set("Content-Type", "application/json");
    reqInit.body = JSON.stringify(opts.jsonBody);
  } else if (opts.formData) {
    // Don't set Content-Type — fetch will populate it with the multipart
    // boundary. Setting it manually breaks multipart parsing.
    reqInit.body = opts.formData;
  }

  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = env[PROMO_BINDING];
    if (binding) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const internalUrl = `https://internal${trimmed}`;
      if (method !== "GET" && method !== "HEAD") {
        reqHeaders.set("Origin", new URL(internalUrl).origin);
      }
      const internalReq = new Request(internalUrl, {
        ...reqInit,
        headers: reqHeaders
      });
      return await binding.fetch(internalReq);
    }
  } catch {
    // fall through to URL fallback (next dev / non-Workers runtime)
  }

  const url = await workerUrl(path);
  if (method !== "GET" && method !== "HEAD") {
    reqHeaders.set("Origin", new URL(url).origin);
  }
  return await fetch(url, {
    ...reqInit,
    headers: reqHeaders,
    cache: "no-store"
  });
}

// ---------------------------------------------------------------------------
// Read helpers (Brief 158a)
// ---------------------------------------------------------------------------

export interface ListPromosParams {
  /** Comma-separated PromoStatus list. The worker enforces the enum. */
  status?: string;
  priority?: PromoPriority;
  assignedToMe?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

function buildListQuery(params: ListPromosParams): string {
  const sp = new URLSearchParams();
  if (params.status) sp.set("status", params.status);
  if (params.priority) sp.set("priority", params.priority);
  if (params.assignedToMe) sp.set("assigned_to_me", "1");
  if (params.search) sp.set("search", params.search);
  if (params.limit != null) sp.set("limit", String(params.limit));
  if (params.offset != null) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * GET /promo/api/promos — any non-null promoRole.
 * Returns null on 401/403 (apps/web renders <NoAccessCard> for those).
 * Throws on other non-2xx responses so the page can surface a banner.
 */
export async function listPromos(
  params: ListPromosParams = {}
): Promise<PromoListResponse | null> {
  const resp = await callPromo(`/promo/api/promos${buildListQuery(params)}`);
  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) {
    throw new Error(`listPromos failed: ${resp.status}`);
  }
  return (await resp.json()) as PromoListResponse;
}

/**
 * Convenience wrapper for the IT queue page — same backing endpoint as
 * listPromos but with `assigned_to_me=1` pre-applied. Keeps the page-level
 * call site self-documenting.
 */
export async function listMyAssignments(
  extras: Omit<ListPromosParams, "assignedToMe"> = {}
): Promise<PromoListResponse | null> {
  return listPromos({ ...extras, assignedToMe: true });
}

/**
 * GET /promo/api/promos/{id} — any non-null promoRole.
 *
 * Returns null on:
 *   - 404 (the promo doesn't exist; callers should `notFound()`)
 *   - 401/403 (callers should render <NoAccessCard>)
 */
export async function getPromo(id: string): Promise<PromoDetail | null> {
  const resp = await callPromo(`/promo/api/promos/${encodeURIComponent(id)}`);
  if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    throw new Error(`getPromo failed: ${resp.status}`);
  }
  const data = (await resp.json()) as PromoDetailResponse;
  return data.promo;
}

/**
 * Brief 158b — full list of locations for the create-promo form's
 * multi-select. Returns `{locationCode, locationPretty, site}[]` ordered
 * alphabetically by display name. Fail-soft: returns [] on error so the
 * create form degrades to "type the location codes manually".
 */
export interface PromoLocationOption {
  locationCode: string;
  locationPretty: string;
  site: string | null;
}

export async function listAllLocations(): Promise<PromoLocationOption[]> {
  const resp = await callPromo("/promo/api/locations");
  if (!resp.ok) return [];
  const data = (await resp
    .json()
    .catch(() => ({ locations: [] as PromoLocationOption[] }))) as {
    locations: PromoLocationOption[];
  };
  return Array.isArray(data.locations) ? data.locations : [];
}

/**
 * Brief 158b — bulk-resolve location codes → contact email list. Used by
 * the AnnouncementComposeModal to pre-populate recipients from the promo's
 * locations. Endpoint reads `pricing_simple.am_email / rm_email /
 * site_email` per code via the worker's existing service-key binding.
 */
export async function resolveRecipientsByLocations(
  locationCodes: string[]
): Promise<string[]> {
  if (locationCodes.length === 0) return [];
  const sp = new URLSearchParams();
  sp.set("codes", locationCodes.join(","));
  const resp = await callPromo(`/promo/api/locations/recipients?${sp}`);
  if (!resp.ok) return [];
  const data = (await resp
    .json()
    .catch(() => ({ recipients: [] as string[] }))) as { recipients: string[] };
  return Array.isArray(data.recipients) ? data.recipients : [];
}

// ---------------------------------------------------------------------------
// Write helpers (Brief 158b)
// ---------------------------------------------------------------------------

/**
 * Result shape every server action interprets to build an ActionResult.
 *   - ok=true → action returns `{ ok: true, message?, data? }`.
 *   - ok=false → action returns `{ ok: false, error, fields? }`.
 */
export type WorkerWriteResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: string;
      fields?: Record<string, string>;
    };

interface ErrorResponseShape {
  error?: string;
  fields?: Record<string, string>;
  message?: string;
  missing?: string[];
  invalid?: string[];
  allowed_emails?: string[];
}

async function parseErrorBody(resp: Response): Promise<ErrorResponseShape> {
  try {
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return (await resp.json().catch(() => ({}))) as ErrorResponseShape;
    }
  } catch {
    // fall through
  }
  return {};
}

async function writeJson<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown
): Promise<WorkerWriteResult<T>> {
  const resp = await callPromo(path, {
    method,
    jsonBody: body
  });
  if (resp.ok) {
    if (resp.status === 204) return { ok: true, data: {} as T };
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return { ok: true, data: {} as T };
    }
    const data = (await resp.json().catch(() => ({}))) as T;
    return { ok: true, data };
  }
  const parsed = await parseErrorBody(resp);
  return {
    ok: false,
    status: resp.status,
    error: parsed.error ?? `HTTP ${resp.status}`,
    fields: parsed.fields
  };
}

async function writeMultipart<T>(
  path: string,
  formData: FormData
): Promise<WorkerWriteResult<T>> {
  const resp = await callPromo(path, { method: "POST", formData });
  if (resp.ok) {
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return { ok: true, data: {} as T };
    }
    const data = (await resp.json().catch(() => ({}))) as T;
    return { ok: true, data };
  }
  const parsed = await parseErrorBody(resp);
  return {
    ok: false,
    status: resp.status,
    error: parsed.error ?? `HTTP ${resp.status}`,
    fields: parsed.fields
  };
}

// ---- Create ------------------------------------------------------------

export interface CreatePromoBody {
  title: string;
  promoType: PromoType;
  posBehavior?: string | null;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  priority: PromoPriority;
  locationCodes: string[];
}

export interface CreatePromoResponseData {
  ok: true;
  promo: PromoDetail;
}

export async function createPromo(
  body: CreatePromoBody
): Promise<WorkerWriteResult<CreatePromoResponseData>> {
  return writeJson<CreatePromoResponseData>("/promo/api/promos", "POST", body);
}

// ---- Status ------------------------------------------------------------

export interface PatchStatusResponseData {
  ok: true;
  status: PromoStatus;
  previousStatus?: PromoStatus;
  unchanged?: boolean;
}

export async function patchPromoStatus(
  promoId: string,
  status: PromoStatus
): Promise<WorkerWriteResult<PatchStatusResponseData>> {
  return writeJson<PatchStatusResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/status`,
    "PATCH",
    { status }
  );
}

// ---- Ticket ------------------------------------------------------------

export interface PatchTicketBody {
  readyByDate?: string | null;
  roadblocks?: string | null;
  internalNote?: string | null;
}

export interface PatchTicketResponseData {
  ok: true;
  ticket: {
    readyByDate: string | null;
    roadblocks: string | null;
    internalNote?: string | null;
    updatedAt: string;
    readyByUpdatedAt: string | null;
    readyByUpdatedBy: string | null;
  };
  promoStatus?: PromoStatus;
}

export async function patchPromoTicket(
  promoId: string,
  body: PatchTicketBody
): Promise<WorkerWriteResult<PatchTicketResponseData>> {
  return writeJson<PatchTicketResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/ticket`,
    "PATCH",
    body
  );
}

// ---- Assignees ---------------------------------------------------------

export interface AddAssigneeResponseData {
  ok: true;
  assignee: { userId: string; assignedAt: string; assignedBy: string | null };
  promoStatus?: PromoStatus;
}

export async function addPromoAssignee(
  promoId: string,
  userId: string
): Promise<WorkerWriteResult<AddAssigneeResponseData>> {
  return writeJson<AddAssigneeResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/assignees`,
    "POST",
    { userId }
  );
}

export async function removePromoAssignee(
  promoId: string,
  userId: string
): Promise<WorkerWriteResult<{ ok: true }>> {
  return writeJson<{ ok: true }>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/assignees/${encodeURIComponent(userId)}`,
    "DELETE"
  );
}

// ---- Location progress -------------------------------------------------

export interface PatchLocationProgressResponseData {
  ok: true;
  locationCode: string;
  isComplete: boolean;
  completedAt: string | null;
}

export async function patchPromoLocationProgress(
  promoId: string,
  locationCode: string,
  isComplete: boolean
): Promise<WorkerWriteResult<PatchLocationProgressResponseData>> {
  return writeJson<PatchLocationProgressResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/locations/${encodeURIComponent(locationCode)}`,
    "PATCH",
    { isComplete }
  );
}

// ---- Materials ---------------------------------------------------------

export interface UploadMaterialResponseData {
  ok: true;
  material: {
    id: string;
    name: string;
    kind: string;
    r2Key: string;
    fileMime: string | null;
    fileSizeBytes: number | null;
    uploadedAt: string;
    uploadedBy: string;
  };
}

export async function uploadPromoMaterial(
  promoId: string,
  formData: FormData
): Promise<WorkerWriteResult<UploadMaterialResponseData>> {
  return writeMultipart<UploadMaterialResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/materials`,
    formData
  );
}

export async function deletePromoMaterial(
  promoId: string,
  materialId: string
): Promise<WorkerWriteResult<{ ok: true }>> {
  return writeJson<{ ok: true }>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/materials/${encodeURIComponent(materialId)}`,
    "DELETE"
  );
}

// ---- PTP ---------------------------------------------------------------

export interface PutPtpBody {
  purpose: string;
  tools: string;
  process: string;
}

export interface PutPtpResponseData {
  ok: true;
  ptp: {
    purpose: string;
    tools: string;
    process: string;
    updatedAt: string;
    updatedBy: string | null;
  };
}

export async function putPromoPtp(
  promoId: string,
  body: PutPtpBody
): Promise<WorkerWriteResult<PutPtpResponseData>> {
  return writeJson<PutPtpResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/ptp`,
    "PUT",
    body
  );
}

// ---- Announcement ------------------------------------------------------

export interface SendAnnouncementBody {
  subject: string;
  bodyText: string;
  recipientEmails: string[];
  selectedMaterialIds?: string[];
  includePtp?: boolean;
}

export interface SendAnnouncementResponseData {
  ok: true;
  announcementId: string;
  enqueuedCount: number;
  failedRecipients: string[];
  sentAt: string;
}

export async function sendPromoAnnouncement(
  promoId: string,
  body: SendAnnouncementBody
): Promise<WorkerWriteResult<SendAnnouncementResponseData>> {
  return writeJson<SendAnnouncementResponseData>(
    `/promo/api/promos/${encodeURIComponent(promoId)}/announce`,
    "POST",
    body
  );
}

// ---------------------------------------------------------------------------
// Re-exports (callers prefer importing types from this module by convention)
// ---------------------------------------------------------------------------

export type {
  PromoDetail,
  PromoListResponse,
  PromoPriority,
  PromoStatus
} from "./types";
