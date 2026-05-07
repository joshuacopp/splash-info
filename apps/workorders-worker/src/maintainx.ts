// Brief 70 — MaintainX read-only client for splash-workorders.
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

/** Subset of the MaintainX work order JSON shape we actually consume.
 *  Treat unknown extra fields as forward-compatible — we only project
 *  what the page renders. */
export interface RawWorkOrder {
  id: number;
  sequentialId?: number | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  dueDate?: string | null;
  description?: string | null;
  /** Resolved when caller passes `expand=assignees`. */
  assignees?: Array<{ id?: number; firstName?: string | null; lastName?: string | null; fullName?: string | null }>;
  /** Resolved when caller passes `expand=location`. */
  location?: { id?: number; name?: string | null } | null;
  /** Often present without expand; integer ID alongside the optional
   *  expanded object. We read whichever is populated. */
  locationId?: number | null;
  /** Resolved when caller passes `expand=thumbnail`. */
  thumbnail?: { url?: string | null } | null;
  thumbnailUrl?: string | null;
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
}

export interface FetchResult {
  ok: boolean;
  workOrders: RawWorkOrder[];
  /** True iff MaintainX returned a non-null pagination cursor. v1 doesn't
   *  follow the cursor; the page surfaces a "showing first 200" banner. */
  truncated: boolean;
  error: string | null;
  status: number;
}

/** Statuses we care about. Excludes DONE / CANCELED / SKIPPED — operators
 *  who want closed WOs follow the link out to MaintainX itself. */
const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "ON_HOLD"] as const;

function buildUrl(input: FetchInput): string {
  const base = input.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/workorders`);

  for (const status of ACTIVE_STATUSES) {
    url.searchParams.append("statuses", status);
  }
  for (const expansion of ["assignees", "location", "thumbnail"]) {
    url.searchParams.append("expand", expansion);
  }
  url.searchParams.set("limit", "200");
  url.searchParams.set("sort", "-updatedAt");

  if (input.maintainxLocationIds && input.maintainxLocationIds.length > 0) {
    for (const id of input.maintainxLocationIds) {
      url.searchParams.append("locations", String(id));
    }
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
  truncated: boolean;
} {
  if (!body || typeof body !== "object") {
    return { workOrders: [], truncated: false };
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

  const cursor = (obj as { nextCursor?: unknown; nextPageUrl?: unknown }).nextCursor
    ?? (obj as { nextCursor?: unknown; nextPageUrl?: unknown }).nextPageUrl
    ?? null;
  const truncated = cursor !== null && cursor !== undefined && cursor !== "";

  if (!Array.isArray(arr)) return { workOrders: [], truncated };

  const workOrders: RawWorkOrder[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number.parseInt(String(r.id ?? ""), 10);
    if (!Number.isFinite(id)) continue;
    workOrders.push(raw as RawWorkOrder);
  }
  return { workOrders, truncated };
}

export async function fetchMaintainXWorkOrders(input: FetchInput): Promise<FetchResult> {
  const url = buildUrl(input);

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
      truncated: false,
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
      truncated: false,
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
      truncated: false,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status
    };
  }

  const { workOrders, truncated } = extractWorkOrders(parsed);
  return {
    ok: true,
    workOrders,
    truncated,
    error: null,
    status: res.status
  };
}
