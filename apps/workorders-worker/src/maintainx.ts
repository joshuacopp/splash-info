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
