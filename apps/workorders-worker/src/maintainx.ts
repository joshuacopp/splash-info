// Brief 70 — MaintainX read-only client for splash-workorders.
// Brief 72 — adds optional cursor pagination for multi-location users.
//
// This module is the GET-side counterpart to
// `apps/damage-worker/src/maintainx.ts` (which owns the POST /workorders
// path for Briefs 42 / 43). The two workers are domain-isolated: damage
// owns WO creation, workorders owns WO listing. Both bind the same
// `MAINTAINX_API_KEY` secret value.
//
// Helper never throws: fetch errors / non-2xx / non-JSON all surface
// through the FetchResult shape. Caller decides what to map onto HTTP
// status codes.

const ERROR_BODY_MAX_BYTES = 2 * 1024;

// Brief 72: hard ceiling on pagination iterations regardless of
// `maxWorkOrders`. Defends against a buggy MaintainX cursor that keeps
// returning a non-null `nextCursor` indefinitely. Hitting this ceiling
// emits a console.warn and force-breaks with `truncated = true`.
const MAX_PAGE_ITERATIONS = 10;

const PAGE_LIMIT = 200;

/** Subset of the MaintainX work order JSON shape we actually consume.
 *  Treat unknown extra fields as forward-compatible — we only project
 *  what the page renders. */
export interface RawWorkOrder {
  id: number;
  sequentialId?: number | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  /** MaintainX work-order type. Per the API sample: REACTIVE / PREVENTIVE
   *  / CYCLE_COUNT and possibly other values. The field is on the WO body
   *  without an `expand` parameter. Brief 71 buckets `PREVENTIVE` into
   *  the Preventive tab; everything else lands under Reactive. */
  type?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  dueDate?: string | null;
  description?: string | null;
  /** Resolved when caller passes `expand=assignees`. Per Brief 46 the
   *  upstream shape on writes is `{ id, type: "USER" }`; reads carry
   *  the same `type` field plus assignee-side metadata when available. */
  assignees?: Array<{
    id?: number;
    type?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
  }>;
  /** Resolved when caller passes `expand=location`. */
  location?: { id?: number; name?: string | null } | null;
  /** Often present without expand; integer ID alongside the optional
   *  expanded object. We read whichever is populated. */
  locationId?: number | null;
  /** Resolved when caller passes `expand=categories`. Brief 71 surfaces
   *  these as small badges on the expanded-row drawer in apps/web. */
  categories?: Array<string | { name?: string | null }>;
}

export interface FetchInput {
  apiKey: string;
  baseUrl: string;
  /** When omitted (global path) the `locations=` query param is not sent —
   *  MaintainX returns work orders across the whole organization. */
  maintainxLocationIds?: number[];
  /** Caller-supplied AbortSignal so the handler can enforce a timeout. */
  signal?: AbortSignal;
  /** Brief 72: when false the helper makes a single MaintainX call (the
   *  Brief 70 / 71 behavior). When true it walks the `nextCursor` chain
   *  until either `maxWorkOrders` is reached or the cursor goes null. */
  paginate: boolean;
  /** Brief 72: cap on the accumulated work orders when paginate=true.
   *  Ignored when paginate=false (the single 200-cap call applies). */
  maxWorkOrders: number;
}

export interface FetchResult {
  ok: boolean;
  workOrders: RawWorkOrder[];
  /** True iff there are MORE rows upstream than the helper returned —
   *  either the single-call cursor was non-null, or the paginated walk
   *  hit `maxWorkOrders` / the iteration ceiling before exhausting the
   *  queue. */
  truncated: boolean;
  /** Brief 72: number of MaintainX API calls actually made. 1 for the
   *  single-call path. Useful for observability + debug surfaces. */
  pageCount: number;
  error: string | null;
  status: number;
}

/** Statuses we care about. Excludes DONE / CANCELED / SKIPPED — operators
 *  who want closed WOs follow the link out to MaintainX itself. */
const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "ON_HOLD"] as const;

function buildUrl(input: FetchInput, cursor: string | null): string {
  const base = input.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/workorders`);

  for (const status of ACTIVE_STATUSES) {
    url.searchParams.append("statuses", status);
  }
  // Brief 71: drop `thumbnail` (the page no longer renders thumbnails);
  // add `categories` so the expanded-row drawer can show category badges.
  for (const expansion of ["assignees", "location", "categories"]) {
    url.searchParams.append("expand", expansion);
  }
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("sort", "-updatedAt");

  if (input.maintainxLocationIds && input.maintainxLocationIds.length > 0) {
    for (const id of input.maintainxLocationIds) {
      url.searchParams.append("locations", String(id));
    }
  }
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  return url.toString();
}

/**
 * Pull MaintainX's response body into our `RawWorkOrder[]` projection.
 * MaintainX's docs aren't fully formal in this repo yet, so try the
 * common envelope shapes (top-level array, `{ data: [...] }`, or
 * `{ workOrders: [...] }`) before giving up.
 */
function extractWorkOrders(body: unknown): {
  workOrders: RawWorkOrder[];
  nextCursor: string | null;
} {
  if (!body || typeof body !== "object") {
    return { workOrders: [], nextCursor: null };
  }
  const obj = body as Record<string, unknown>;

  let arr: unknown = null;
  if (Array.isArray(obj)) {
    arr = obj;
  } else if (Array.isArray(obj.data)) {
    arr = obj.data;
  } else if (Array.isArray(obj.workOrders)) {
    arr = obj.workOrders;
  } else if (Array.isArray((obj as { results?: unknown }).results)) {
    arr = (obj as { results: unknown }).results;
  }

  const cursorRaw = (obj as { nextCursor?: unknown; nextPageUrl?: unknown }).nextCursor
    ?? (obj as { nextCursor?: unknown; nextPageUrl?: unknown }).nextPageUrl
    ?? null;
  const nextCursor =
    typeof cursorRaw === "string" && cursorRaw !== "" ? cursorRaw : null;

  if (!Array.isArray(arr)) return { workOrders: [], nextCursor };

  const workOrders: RawWorkOrder[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number.parseInt(String(r.id ?? ""), 10);
    if (!Number.isFinite(id)) continue;
    workOrders.push(raw as RawWorkOrder);
  }
  return { workOrders, nextCursor };
}

interface SinglePageResult {
  ok: boolean;
  workOrders: RawWorkOrder[];
  nextCursor: string | null;
  error: string | null;
  status: number;
}

async function fetchOnePage(input: FetchInput, cursor: string | null): Promise<SinglePageResult> {
  const url = buildUrl(input, cursor);

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
      workOrders: [],
      nextCursor: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0
    };
  }

  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      // ignore
    }
    return {
      ok: false,
      workOrders: [],
      nextCursor: null,
      error: `MX ${res.status}: ${errText.slice(0, ERROR_BODY_MAX_BYTES)}`,
      status: res.status
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false,
      workOrders: [],
      nextCursor: null,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status
    };
  }

  const { workOrders, nextCursor } = extractWorkOrders(parsed);
  return { ok: true, workOrders, nextCursor, error: null, status: res.status };
}

export async function fetchMaintainXWorkOrders(input: FetchInput): Promise<FetchResult> {
  if (!input.paginate) {
    const page = await fetchOnePage(input, null);
    if (!page.ok) {
      return {
        ok: false,
        workOrders: [],
        truncated: false,
        pageCount: 1,
        error: page.error,
        status: page.status
      };
    }
    return {
      ok: true,
      workOrders: page.workOrders,
      truncated: page.nextCursor !== null,
      pageCount: 1,
      error: null,
      status: page.status
    };
  }

  const accumulator: RawWorkOrder[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let truncated = false;
  let lastStatus = 0;

  while (pageCount < MAX_PAGE_ITERATIONS) {
    const page: SinglePageResult = await fetchOnePage(input, cursor);
    pageCount += 1;
    lastStatus = page.status;

    if (!page.ok) {
      // Partial-result fail-soft: return what we have so far.
      return {
        ok: false,
        workOrders: accumulator,
        truncated: false,
        pageCount,
        error: page.error,
        status: page.status
      };
    }

    for (const wo of page.workOrders) accumulator.push(wo);

    if (accumulator.length >= input.maxWorkOrders) {
      truncated = true;
      accumulator.length = input.maxWorkOrders;
      break;
    }

    if (page.nextCursor === null) {
      truncated = false;
      break;
    }

    cursor = page.nextCursor;

    if (pageCount >= MAX_PAGE_ITERATIONS) {
      console.warn(
        `workorders-worker maintainx pagination hit MAX_PAGE_ITERATIONS=${MAX_PAGE_ITERATIONS}; force-breaking with truncated=true`
      );
      truncated = true;
      break;
    }
  }

  return {
    ok: true,
    workOrders: accumulator,
    truncated,
    pageCount,
    error: null,
    status: lastStatus
  };
}

/* ============================================================
 * Brief 80 — Work Request READ client (GET /v1/workrequests).
 *
 * Companion to the WO read path above. Powers the /workorders
 * "Requests" sub-tab: surfaces the informal intake queue
 * (`/v1/workrequests`) that the New Request tab writes to.
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
 *
 * Same fail-soft posture as `fetchMaintainXWorkOrders`: never throws;
 * fetch errors / non-2xx / non-JSON collapse to `ok: false`.
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
  const base = input.baseUrl.replace(/\/$/, "");
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
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      // ignore
    }
    return {
      ok: false,
      workRequests: [],
      nextCursor: null,
      error: `MX ${res.status}: ${errText.slice(0, ERROR_BODY_MAX_BYTES)}`,
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
        `workorders-worker workrequests pagination hit MAX_PAGE_ITERATIONS=${MAX_PAGE_ITERATIONS}; force-breaking with truncated=true`
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
 * Brief 74 — Work Request create + photo-upload helpers.
 *
 * MaintainX distinguishes "work requests" (informal, anyone-can-file
 * intake; the `/v1/workrequests` resource) from "work orders" (the
 * formal record, `/v1/workorders`). The /workorders New Request tab
 * surfaces a request form, so we POST to /workrequests; MaintainX
 * staff promote the request to a work order on their side.
 *
 * Fail-soft posture (matches the read path): helpers never throw;
 * fetch errors / non-2xx / non-JSON all collapse to a result with
 * `ok: false`. Caller decides what to map onto HTTP status codes
 * (the worker's `POST /workorders/api/request` handler 303-redirects
 * with a query-string error message on failure).
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
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string") {
      const parsed = Number.parseInt(c, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export async function createMaintainXWorkRequest(
  input: CreateWorkRequestInput
): Promise<CreateWorkRequestResult> {
  const base = input.baseUrl.replace(/\/$/, "");
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
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      // ignore
    }
    return {
      ok: false,
      requestId: null,
      error: `MX ${res.status}: ${errText.slice(0, ERROR_BODY_MAX_BYTES)}`,
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
 *  sites unchanged. */
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
  const base = input.baseUrl.replace(/\/$/, "");
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
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      // ignore
    }
    return {
      ok: false,
      publicUrl: null,
      filename: null,
      fileKey: null,
      error: `MX ${res.status}: ${errText.slice(0, ERROR_BODY_MAX_BYTES)}`,
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
