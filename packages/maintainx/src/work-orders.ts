// MaintainX work orders — `/v1/workorders`.
//
// A work ORDER is MaintainX's formal record of scheduled work. Contrast
// `./work-requests.ts`: a work REQUEST is informal, anyone-can-file intake
// that MaintainX staff promote into a work order on their side. Two
// different resources, two different POST bodies; do not conflate them.
//
// The read half of this file was splash-workorders' listing client (Briefs
// 70 / 72). The create half was splash-damage's claim-to-work-order helper
// (Brief 42), with the claim-specific title/description/assignee logic left
// behind in that worker — this package takes an already-built title and
// description and knows nothing about claims.

import { MAX_PAGE_ITERATIONS, mxError, strictNumericId, trimBase } from "./http.js";

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

  // -------------------------------------------------------------------------
  // Ingest fields (Phase 1). Everything below is read by the Supabase ingest
  // in `sync.ts` and ignored by the serving path, so adding them is additive
  // for existing callers. All optional, because MaintainX OMITS null fields
  // from responses rather than sending them as null — an absent key means
  // empty, never "unchanged".
  //
  // Note there is deliberately no `deletedAt`: it never appears on a list
  // payload (0 of 100 rows measured), so deletes are observable only as
  // disappearance from a walk. Reconciliation, not a field, is what catches
  // them.
  //
  // `mx_work_order.raw` stores the full payload regardless, so a field missed
  // here is recoverable without re-walking the corpus.
  // -------------------------------------------------------------------------

  /** Present on preventive work orders — 17,348 of 17,426 carry it. There is
   *  NO `expand` token for this, so if it is absent from the default list
   *  payload it cannot be backfilled without per-work-order fetches. */
  recurrenceInfo?: unknown;
  /** Resolved by `expand=time_items` (snake_case; camelCase 400s). Store
   *  THESE, not `times` — `times` is the aggregated view and is derivable by
   *  summing these. Confirmed on WO 118160263: two raw entries of 7705s and
   *  5221s against one aggregated 12926s. */
  timeItems?: Array<Record<string, unknown>>;
  /** Aggregated labor time. Derivable from `timeItems`; kept only so a caller
   *  can cross-check. */
  times?: Array<Record<string, unknown>>;
  /** Resolved by `expand=parts`. */
  parts?: Array<Record<string, unknown>>;
  /** Resolved by `expand=expenditures`. Effectively always empty today — 23
   *  work orders and 25 line items across a full six months. Line items carry
   *  NO id, so they must be written delete-and-replace keyed on a content
   *  hash, never on ordinal. */
  expenditures?: Array<Record<string, unknown>>;
  /** The requester, present on 86% of REACTIVE work orders and 1 of 17,426
   *  preventive. Resolve to an email via `GET /users` — this is the join that
   *  the Phase 6 cost email depends on. */
  requesterId?: number | null;
  /** Comment watermark. `updatedAt` does NOT move when a comment is added, so
   *  this is the only field that reveals comment activity. */
  lastMessageSentAt?: string | null;
  completedAt?: string | null;
  completerId?: number | null;
  creatorId?: number | null;
  startDate?: string | null;
  partStatus?: string | null;
  estimatedTimeSeconds?: number | null;
  organizationId?: number | null;
  assetId?: number | null;
  dueDateIsFullDay?: boolean | null;
  workOrderSummary?: unknown;
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
  /** Server-side status filter. Omit for the open-work default
   *  (OPEN / IN_PROGRESS / ON_HOLD); pass ALL_WORK_ORDER_STATUSES to include
   *  closed work. */
  statuses?: readonly string[];
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

/** Default statuses. Excludes DONE / CANCELED / SKIPPED — operators browsing
 *  open work follow the link out to MaintainX for closed WOs.
 *
 *  Callers that need closed work orders pass `statuses` explicitly; the
 *  inventory app does, because it orders approved requests by the state of the
 *  work order they became, and "done last" requires seeing the done ones. */
const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "ON_HOLD"] as const;

/** Every status MaintainX emits on a work order, for callers that want them
 *  all. */
export const ALL_WORK_ORDER_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "ON_HOLD",
  "DONE",
  "CANCELED",
  "SKIPPED"
] as const;

/**
 * Fetch ONE work order by id — `GET /v1/workorders/{id}`.
 *
 * Use this when you know exactly which work orders you want. The list helper
 * below filters by location and status and pages through results, so pulling a
 * specific closed work order out of it means asking for every closed work
 * order at that location and hoping yours is inside the row cap. This is exact
 * and cheap for a handful of ids; it is one HTTP call each, so do not loop it
 * over hundreds.
 *
 * Fail-soft like everything else here: resolves with `workOrder: null` and an
 * `error` rather than throwing.
 */
export async function fetchMaintainXWorkOrder(input: {
  id: number;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; workOrder: RawWorkOrder | null; error: string | null; status: number }> {
  const url = `${trimBase(input.baseUrl)}/workorders/${input.id}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
      signal: input.signal
    });
  } catch (e) {
    return {
      ok: false,
      workOrder: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0
    };
  }

  if (!res.ok) {
    return { ok: false, workOrder: null, error: await mxError(res), status: res.status };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false,
      workOrder: null,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status
    };
  }

  // Live responses wrap the row as { workOrder: {...} }; accept a bare object
  // too, matching the defensive envelope handling on every other read here.
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const body = (obj.workOrder ?? obj.data ?? obj) as RawWorkOrder;
  const id = typeof body?.id === "number" ? body.id : null;
  if (id === null) {
    return {
      ok: false,
      workOrder: null,
      error: `MX ${res.status}: response missing work-order id`,
      status: res.status
    };
  }
  return { ok: true, workOrder: body, error: null, status: res.status };
}

function buildUrl(input: FetchInput, cursor: string | null): string {
  const base = trimBase(input.baseUrl);
  const url = new URL(`${base}/workorders`);

  for (const status of input.statuses ?? ACTIVE_STATUSES) {
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
    return {
      ok: false,
      workOrders: [],
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
        `maintainx workorders pagination hit MAX_PAGE_ITERATIONS=${MAX_PAGE_ITERATIONS}; force-breaking with truncated=true`
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
 * Work Order CREATE (POST /v1/workorders).
 *
 * Originally damage-worker's Brief 42 helper. What moved here is only the
 * HTTP half: body assembly from already-formatted strings, the request, and
 * id extraction. What did NOT move, and must not, is how a domain object
 * becomes a title and a description — damage-worker still owns
 * claim -> {title, description, categories, assignees} and passes the result
 * in. A shared client that imported `ClaimRow` would not be shared.
 * ============================================================ */

/** An assignee reference. `type` is REQUIRED and must be "USER" — MaintainX
 *  400s with an `assignees.0.type` fieldPath if it is missing (confirmed
 *  2026-05-06, Brief 46). It is typed as a literal here so the compiler
 *  catches the omission rather than MaintainX doing it at runtime. */
export interface MaintainXAssignee {
  type: "USER";
  id: number;
}

export interface CreateWorkOrderInput {
  title: string;
  description: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  /** MaintainX category names, e.g. ["Vehicle Damage"]. Omitted from the
   *  body when undefined. */
  categories?: readonly string[];
  assignees?: readonly MaintainXAssignee[];
  /** Omitted from the body when null/undefined, which is meaningful: an
   *  unmapped site files an unlocated work order rather than failing. */
  locationId?: number | null;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}

export interface CreateWorkOrderResult {
  ok: boolean;
  workOrderId: number | null;
  error: string | null;
  /** HTTP status (or 0 if request never sent / network error). */
  status: number;
  /** Compact payload echoed back for audit/log purposes. */
  request: Record<string, unknown>;
}

function buildWorkOrderPayload(input: CreateWorkOrderInput): Record<string, unknown> {
  // Key insertion order is preserved deliberately: `request` is echoed back
  // and JSON-stringified into damage-worker's activity log, so reordering
  // here would churn every logged payload for no reason.
  const body: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    priority: input.priority
  };
  if (input.categories !== undefined) body.categories = input.categories;
  if (input.assignees !== undefined) body.assignees = input.assignees;
  if (input.locationId != null) body.locationId = input.locationId;
  return body;
}

/**
 * Extract the created Work Order ID from a MaintainX response body. The
 * API response shape isn't formally locked in this repo yet — try the
 * top-level `id` first (MaintainX docs example), then `workOrder.id`,
 * then `data.id`. Returns null if none parse.
 */
function extractWorkOrderId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const candidates: unknown[] = [
    obj.id,
    (obj.workOrder as { id?: unknown } | undefined)?.id,
    (obj.data as { id?: unknown } | undefined)?.id
  ];
  for (const c of candidates) {
    const n = strictNumericId(c);
    if (n !== null) return n;
  }
  return null;
}

export async function createMaintainXWorkOrder(
  input: CreateWorkOrderInput
): Promise<CreateWorkOrderResult> {
  const body = buildWorkOrderPayload(input);
  const url = `${trimBase(input.baseUrl)}/workorders`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(body),
      signal: input.signal
    });
  } catch (e) {
    return {
      ok: false,
      workOrderId: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0,
      request: body
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      workOrderId: null,
      error: await mxError(res),
      status: res.status,
      request: body
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Non-JSON body on a 2xx — surface as a parse failure but keep status.
    return {
      ok: false,
      workOrderId: null,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status,
      request: body
    };
  }

  const workOrderId = extractWorkOrderId(parsed);
  if (workOrderId == null) {
    return {
      ok: false,
      workOrderId: null,
      error: `MX ${res.status}: response missing recognizable work order id (tried id, workOrder.id, data.id)`,
      status: res.status,
      request: body
    };
  }

  return {
    ok: true,
    workOrderId,
    error: null,
    status: res.status,
    request: body
  };
}
