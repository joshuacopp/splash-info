// MaintainX work requests — `/v1/workrequests`.
//
// A work REQUEST is MaintainX's informal, anyone-can-file intake record.
// Staff promote it into a work ORDER (`./work-orders.ts`) on their side,
// at which point the request carries a `workOrderId`. Callers who want a
// formal record created directly want the work-order create instead.
//
// Same fail-soft posture as the work-order client: nothing here throws.

import {
  MAX_PAGE_ITERATIONS,
  looseNumericId,
  mxError,
  trimBase
} from "./http.js";

/* ============================================================
 * READ — GET /v1/workrequests (Brief 80).
 *
 * Two facts drive the shape of this helper, learned from a live
 * `GET /v1/workrequests` sample plus the endpoint's query-param docs
 * (both 2026-07-22):
 *   1. The plain call returns the WHOLE org's requests (all locations,
 *      all statuses), sorted `updatedAt` desc, cursor-paginated (100/
 *      page). The docs confirm `locations=` AND `statuses=` filters on
 *      this resource, so Brief 80 sends both server-side (locations =
 *      the user's mapped IDs; statuses = PENDING+REJECTED) to keep the
 *      cursor walk short. The CALLER still hard-filters by mapped
 *      location IDs and visible statuses as defense-in-depth — correct
 *      even if a param were silently dropped.
 *   2. Request rows carry `requestStatus` (PENDING / APPROVED /
 *      REJECTED / DONE) and a `workOrderId` once promoted — NOT the
 *      WO `type` field.
 * ============================================================ */

/** Subset of the MaintainX work-request JSON we consume. Forward-
 *  compatible: unknown extra fields are ignored. */
export interface RawWorkRequest {
  id: number;
  title?: string | null;
  description?: string | null;
  priority?: string | null;
  /** PENDING / APPROVED / REJECTED / DONE. */
  requestStatus?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Integer ID, present without expand. */
  locationId?: number | null;
  /** Resolved only when the endpoint honors `expand=location`. */
  location?: { id?: number; name?: string | null } | null;
  /** Set once staff promote the request to a work order. */
  workOrderId?: number | null;
  /** MaintainX user ID of the filer; resolved to a name caller-side
   *  via the `maintainx_users` cache. */
  creatorId?: number | null;
  assetId?: number | null;
}

const WORK_REQUEST_PAGE_LIMIT = 100;

export interface FetchWorkRequestsInput {
  apiKey: string;
  baseUrl: string;
  /** Server-side location filter — confirmed supported on this resource
   *  (docs verified 2026-07-22). The caller still re-filters by mapped IDs
   *  as defense-in-depth. */
  maintainxLocationIds?: number[];
  /** Server-side status filter — confirmed supported (Items Enum:
   *  APPROVED / DONE / PENDING / REJECTED). Brief 80 passes
   *  ["PENDING","REJECTED"] so the cursor walk skips promoted/closed
   *  requests entirely. Caller re-filters regardless. */
  statuses?: string[];
  /** Cap on accumulated rows across the cursor walk. */
  maxWorkRequests: number;
  signal?: AbortSignal;
}

export interface FetchWorkRequestsResult {
  ok: boolean;
  workRequests: RawWorkRequest[];
  /** True iff more rows exist upstream than we returned (hit the row
   *  cap or the page-iteration ceiling before the cursor went null). */
  truncated: boolean;
  pageCount: number;
  error: string | null;
  status: number;
}

function buildWorkRequestsUrl(input: FetchWorkRequestsInput, cursor: string | null): string {
  const base = trimBase(input.baseUrl);
  const url = new URL(`${base}/workrequests`);
  url.searchParams.append("expand", "location");
  url.searchParams.set("limit", String(WORK_REQUEST_PAGE_LIMIT));
  if (input.maintainxLocationIds && input.maintainxLocationIds.length > 0) {
    for (const id of input.maintainxLocationIds) {
      url.searchParams.append("locations", String(id));
    }
  }
  if (input.statuses && input.statuses.length > 0) {
    for (const status of input.statuses) {
      url.searchParams.append("statuses", status);
    }
  }
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

function extractWorkRequests(body: unknown): {
  workRequests: RawWorkRequest[];
  nextCursor: string | null;
} {
  if (!body || typeof body !== "object") {
    return { workRequests: [], nextCursor: null };
  }
  const obj = body as Record<string, unknown>;

  let arr: unknown = null;
  if (Array.isArray(obj)) {
    arr = obj;
  } else if (Array.isArray(obj.workRequests)) {
    arr = obj.workRequests;
  } else if (Array.isArray(obj.data)) {
    arr = obj.data;
  } else if (Array.isArray((obj as { results?: unknown }).results)) {
    arr = (obj as { results: unknown }).results;
  }

  const cursorRaw =
    (obj as { nextCursor?: unknown }).nextCursor ?? null;
  const nextCursor =
    typeof cursorRaw === "string" && cursorRaw !== "" ? cursorRaw : null;

  if (!Array.isArray(arr)) return { workRequests: [], nextCursor };

  const workRequests: RawWorkRequest[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number.parseInt(String(r.id ?? ""), 10);
    if (!Number.isFinite(id)) continue;
    workRequests.push(raw as RawWorkRequest);
  }
  return { workRequests, nextCursor };
}

interface SingleWorkRequestPage {
  ok: boolean;
  workRequests: RawWorkRequest[];
  nextCursor: string | null;
  error: string | null;
  status: number;
}

async function fetchOneWorkRequestPage(
  input: FetchWorkRequestsInput,
  cursor: string | null
): Promise<SingleWorkRequestPage> {
  const url = buildWorkRequestsUrl(input, cursor);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json"
      },
      signal: input.signal
    });
  } catch (e) {
    return {
      ok: false,
      workRequests: [],
      nextCursor: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      workRequests: [],
      nextCursor: null,
      error: await mxError(res),
      status: res.status
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false,
      workRequests: [],
      nextCursor: null,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status
    };
  }

  const { workRequests, nextCursor } = extractWorkRequests(parsed);
  return { ok: true, workRequests, nextCursor, error: null, status: res.status };
}

/**
 * Walk the `/workrequests` cursor chain until the row cap or the
 * iteration ceiling is hit (or the cursor goes null). Always
 * paginates — unlike the WO path there's no single-location fast
 * path, because location filtering isn't guaranteed server-side, so
 * a single-location user may still need several pages of org-wide
 * results to surface all of their PENDING/REJECTED requests. The
 * caller hard-filters what comes back.
 */
export async function fetchMaintainXWorkRequests(
  input: FetchWorkRequestsInput
): Promise<FetchWorkRequestsResult> {
  const accumulator: RawWorkRequest[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let truncated = false;
  let lastStatus = 0;

  while (pageCount < MAX_PAGE_ITERATIONS) {
    const page: SingleWorkRequestPage = await fetchOneWorkRequestPage(input, cursor);
    pageCount += 1;
    lastStatus = page.status;

    if (!page.ok) {
      // Partial-result fail-soft: return what we accumulated so far.
      return {
        ok: false,
        workRequests: accumulator,
        truncated: false,
        pageCount,
        error: page.error,
        status: page.status
      };
    }

    for (const wr of page.workRequests) accumulator.push(wr);

    if (accumulator.length >= input.maxWorkRequests) {
      truncated = true;
      accumulator.length = input.maxWorkRequests;
      break;
    }

    if (page.nextCursor === null) {
      truncated = false;
      break;
    }

    cursor = page.nextCursor;

    if (pageCount >= MAX_PAGE_ITERATIONS) {
      console.warn(
        `maintainx workrequests pagination hit MAX_PAGE_ITERATIONS=${MAX_PAGE_ITERATIONS}; force-breaking with truncated=true`
      );
      truncated = true;
      break;
    }
  }

  return {
    ok: true,
    workRequests: accumulator,
    truncated,
    pageCount,
    error: null,
    status: lastStatus
  };
}

/* ============================================================
 * CREATE + photo upload (Briefs 74 / 76).
 *
 * NO IDEMPOTENCY KEY EXISTS on this endpoint. A retried or
 * double-submitted POST creates a second work request. Callers are
 * responsible for guarding the submit path.
 * ============================================================ */

/** MaintainX `/v1/workrequests` POST body fields we populate. Optional
 *  fields (`assetId`, `approverTeamId`, `extraFields`) are omitted in
 *  v1 — staff route assets / approvers MX-side after the request lands. */
export interface CreateWorkRequestInput {
  title: string;
  description: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  locationId: number;
  /** MaintainX expects this field as the requester contact identifier
   *  (string; an email is the canonical shape). */
  creatorContactInfo: string;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}

export interface CreateWorkRequestResult {
  ok: boolean;
  /** MaintainX work-request ID on success; null on failure. The downstream
   *  upload calls key on this. */
  requestId: number | null;
  error: string | null;
  status: number;
}

function extractWorkRequestId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  // MaintainX docs aren't fully formal in this repo; try the common
  // envelope shapes. Same defensive posture as Brief 42's WO-create
  // helper on damage-worker.
  const candidates: unknown[] = [
    obj.id,
    (obj.workRequest as Record<string, unknown> | undefined)?.id,
    (obj.data as Record<string, unknown> | undefined)?.id
  ];
  for (const c of candidates) {
    const n = looseNumericId(c);
    if (n !== null) return n;
  }
  return null;
}

export async function createMaintainXWorkRequest(
  input: CreateWorkRequestInput
): Promise<CreateWorkRequestResult> {
  const base = trimBase(input.baseUrl);
  const url = `${base}/workrequests`;
  const body = {
    title: input.title,
    description: input.description,
    priority: input.priority,
    locationId: input.locationId,
    creatorContactInfo: input.creatorContactInfo
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body),
      signal: input.signal
    });
  } catch (e) {
    return {
      ok: false,
      requestId: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      requestId: null,
      error: await mxError(res),
      status: res.status
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false,
      requestId: null,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status
    };
  }

  const requestId = extractWorkRequestId(parsed);
  if (requestId == null) {
    return {
      ok: false,
      requestId: null,
      error: `MX ${res.status}: response missing work-request id`,
      status: res.status
    };
  }
  return { ok: true, requestId, error: null, status: res.status };
}

export interface UploadWorkRequestFileInput {
  requestId: number;
  /** Sanitized filename; extension preserved. The helper URL-encodes it
   *  when building the PUT URL. */
  filename: string;
  body: ArrayBuffer;
  apiKey: string;
  baseUrl: string;
  /** "thumbnail" routes to PUT /workrequests/{id}/thumbnail/{filename}
   *  (first photo per request); "attachment" routes to PUT
   *  /workrequests/{id}/attachments/{filename} — note plural URL segment
   *  (the MaintainX doc heading reads "Update work request attachment"
   *  singular but the actual URL path is plural; Brief 76 fixed Brief
   *  74's wrong-singular-path 404). */
  endpoint: "thumbnail" | "attachment";
  signal?: AbortSignal;
}

/** Discriminator → URL segment. Caller passes "attachment" (singular)
 *  matching the doc heading; we emit "attachments" (plural) which is the
 *  actual MaintainX URL segment. Keeping the lookup leaves caller call
 *  sites unchanged.
 *
 *  DO NOT "correct" the plural back to singular. Brief 74 shipped singular
 *  and every attachment upload 404'd; Brief 76 is this table. */
const REQUEST_FILE_URL_SEGMENT: Record<UploadWorkRequestFileInput["endpoint"], string> = {
  thumbnail: "thumbnail",
  attachment: "attachments"
};

export interface UploadWorkRequestFileResult {
  ok: boolean;
  publicUrl: string | null;
  filename: string | null;
  fileKey: string | null;
  error: string | null;
  status: number;
}

export async function uploadMaintainXWorkRequestFile(
  input: UploadWorkRequestFileInput
): Promise<UploadWorkRequestFileResult> {
  const base = trimBase(input.baseUrl);
  const segment = REQUEST_FILE_URL_SEGMENT[input.endpoint];
  const url = `${base}/workrequests/${input.requestId}/${segment}/${encodeURIComponent(input.filename)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/octet-stream",
        Accept: "application/json"
      },
      // Cloudflare Workers' fetch accepts ArrayBuffer / Uint8Array
      // directly as body; let it through unchanged.
      body: input.body,
      signal: input.signal
    });
  } catch (e) {
    return {
      ok: false,
      publicUrl: null,
      filename: null,
      fileKey: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      publicUrl: null,
      filename: null,
      fileKey: null,
      error: await mxError(res),
      status: res.status
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Some MX endpoints return empty body on success — treat as ok with
    // null metadata.
    return {
      ok: true,
      publicUrl: null,
      filename: null,
      fileKey: null,
      error: null,
      status: res.status
    };
  }

  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const publicUrl = typeof obj.publicUrl === "string" ? obj.publicUrl : null;
  const filename = typeof obj.filename === "string" ? obj.filename : null;
  const fileKey = typeof obj.fileKey === "string" ? obj.fileKey : null;
  return {
    ok: true,
    publicUrl,
    filename,
    fileKey,
    error: null,
    status: res.status
  };
}
