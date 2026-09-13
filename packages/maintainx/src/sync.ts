// Page-level MaintainX primitives for the Supabase ingest.
//
// This module exists alongside `work-orders.ts` / `work-requests.ts` rather
// than inside them, because the two have opposite jobs:
//
//   - `fetchMaintainXWorkOrders` serves a page render. It accumulates into an
//     array, self-caps at `maxWorkOrders`, and force-breaks at
//     `MAX_PAGE_ITERATIONS = 10`. Truncating is CORRECT there — a render must
//     be bounded — and three workers depend on that behavior today.
//   - Ingest must not truncate. It walks to cursor exhaustion across many
//     Worker invocations, checkpointing after every page.
//
// Rather than parameterise those semantics into the serving client and make
// every existing caller inherit the risk, ingest gets its own primitive. The
// unit here is ONE PAGE: one HTTP call, no accumulation, no iteration ceiling.
// The caller owns the loop, the cursor and the checkpoint.
//
// The FAIL-SOFT posture of the rest of the package is preserved exactly —
// nothing in this file throws. Network errors, non-2xx responses, unparseable
// bodies and exhausted retries all collapse into `ok: false` with a populated
// `error`, and the caller decides whether to checkpoint-and-retry or give up.
// An ingest pass that throws mid-walk loses its cursor; one that returns
// `ok: false` resumes on the next cron tick.
//
// Every query-parameter fact encoded below was empirically verified against
// the live API on 2026-09-12 by `apps/workorders-worker/scripts/mx-probe-params.py`
// (report: `mx-probe-params-report.json`). MaintainX will accept some params
// and silently ignore them, so that probe validated returned VALUES, not just
// status codes. Do not "simplify" a constant here without re-running it.

import { mxError, trimBase } from "./http.js";
import type { RawWorkOrder } from "./work-orders.js";
import type { RawWorkRequest } from "./work-requests.js";

/** MaintainX rejects `limit > 200` outright:
 *  `400 {"errors":[{"error":"must be <= 200","fieldPath":"limit"}]}`.
 *  Verified: 50/100/150/200 honored exactly, 250/500/1000 rejected. */
export const INGEST_PAGE_LIMIT = 200;

/**
 * The `expand` tokens ingest sends on `GET /workorders`.
 *
 * These back `mx_work_order_part`, `mx_work_order_expenditure` and
 * `mx_work_order_time_item`. NOTE the snake_case: `time_items` is the real
 * token and camelCase `timeItems` is a 400. A single bad token fails the
 * WHOLE page, which mid-backfill means a stalled pass, so this list is
 * deliberately a constant rather than something callers assemble ad hoc.
 *
 * Deliberately absent, because MaintainX has no expand for them:
 * `attachments` (needs a per-work-order `GET /workorders/{id}` — Phase 3),
 * `recurrenceInfo`, `requester`, `workRequest`, `teams`, `vendors`.
 */
export const INGEST_EXPAND = [
  "assignees",
  "location",
  "categories",
  "parts",
  "expenditures",
  "times",
  "time_items",
  "asset"
] as const;

/** Statuses that constitute the live queue. Pass A of the backfill walks
 *  these with NO date bound — ~2,650 currently-open work orders were created
 *  more than six months ago, so a `createdAt` bound would silently drop two
 *  thirds of the live queue. */
export const LIVE_WORK_ORDER_STATUSES = ["OPEN", "IN_PROGRESS", "ON_HOLD"] as const;

/**
 * Statuses that constitute closed history.
 *
 * NO LONGER SENT AS A FILTER. Retained because it is exported from the package
 * index and names a meaningful set, but this exact triple is unusable as a
 * `statuses` query param.
 *
 * TRAP — MEASURED 2026-09-13, DO NOT REINTRODUCE. `GET /workorders` returns
 * HTTP 200 with an EMPTY collection and a NULL cursor whenever `CANCELED` and
 * `SKIPPED` both appear in the `statuses` query param. It is not a 4xx and not
 * an error of any kind, so every walk built on "null cursor means finished"
 * reads it as a completed pass that legitimately had no work. That silently
 * zeroed the history pass and the incremental sweep.
 *
 * Probed directly: DONE alone -> 25 rows, CANCELED alone -> 25, SKIPPED alone
 * -> 18 (the entire account-wide SKIPPED population). DONE+CANCELED,
 * DONE+SKIPPED, OPEN+DONE, OPEN+IN_PROGRESS+ON_HOLD and
 * OPEN+IN_PROGRESS+ON_HOLD+DONE+CANCELED all -> 25. But CANCELED+SKIPPED -> 0,
 * in either order, and so does every superset of that pair
 * (OPEN+CANCELED+SKIPPED, DONE+CANCELED+SKIPPED, all six). Invalid values such
 * as CANCELLED with two Ls correctly 400, so the enum IS validated and all six
 * of these values are legitimate — the pair is what breaks.
 *
 * Every single value works, and every combination that does not contain both
 * CANCELED and SKIPPED works. If you need closed history, send no `statuses`
 * param at all and bound the walk by date instead — that is what the history
 * pass in apps/workorders-worker/src/mx-ingest.ts does.
 */
export const CLOSED_WORK_ORDER_STATUSES = ["DONE", "CANCELED", "SKIPPED"] as const;

/**
 * The complete `sort` enum. Anything else is a 400 — notably there is NO
 * sort by `id`, which rules out the usual "sort by id, resume from last id"
 * pagination fallback. Cursor is the only resumption mechanism available.
 */
export type WorkOrderSort =
  | "updatedAt"
  | "createdAt"
  | "dueDate"
  | "startedAt"
  | "completedAt"
  | "-updatedAt"
  | "-createdAt"
  | "-dueDate"
  | "-startedAt"
  | "-completedAt";

/** A comment on a work order. Objects carry no `updatedAt`, so upsert-on-id
 *  is naturally idempotent — at the cost of never detecting an edit, which
 *  is an accepted limitation. `content` can be an empty string when the
 *  comment is photo-only. */
export interface RawWorkOrderComment {
  id: number;
  authorId?: number | null;
  content?: string | null;
  createdAt?: string | null;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Retry policy. The serving client has none at all — every call is fire-once
 * with no 429 handling anywhere in the package — which is tolerable for a
 * single render and not for a walk of hundreds of pages.
 *
 * Defaults match the probe scripts that ran ~680 requests against the live
 * API without a single 429.
 */
export interface RetryOptions {
  /** Total attempts including the first. 1 disables retrying. */
  attempts?: number;
  /** Delay before the 2nd attempt, doubled each time after. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff wait. */
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000
};

/** Status codes worth retrying. 0 is our own sentinel for a thrown fetch
 *  (DNS failure, connection reset, socket timeout). 4xx other than 429 are
 *  deterministic — a bad `expand` token will be a 400 on every attempt, so
 *  retrying it just burns the invocation's time budget. */
function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Abort-aware sleep. Resolves early rather than rejecting if the signal
 *  fires, because rejecting here would throw out of a fail-soft helper —
 *  the caller's next fetch will observe the abort and return `ok: false`. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * MaintainX documents no rate limits and emits no `X-RateLimit-*` headers,
 * but honor `Retry-After` if it ever shows up — a server-supplied delay always
 * beats our guess. Accepts both the delta-seconds and HTTP-date forms.
 */
function retryAfterMs(res: Response | null): number | null {
  const header = res?.headers?.get("Retry-After");
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

interface RawFetchResult {
  ok: boolean;
  body: unknown;
  error: string | null;
  status: number;
  /** How many attempts were actually made. Surfaced so an ingest pass can
   *  log "this page needed 3 tries" into `mx_sync_state.stats` and a rising
   *  number becomes the early warning that we are being throttled. */
  attempts: number;
}

/** One GET with retry/backoff. Never throws. */
async function getJson(
  url: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  retry: Required<RetryOptions>
): Promise<RawFetchResult> {
  let lastError = "unknown error";
  let lastStatus = 0;
  let delay = retry.baseDelayMs;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        },
        signal
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      lastStatus = 0;
    }

    if (res) {
      if (res.ok) {
        try {
          return { ok: true, body: await res.json(), error: null, status: res.status, attempts: attempt };
        } catch {
          // A 2xx with an unreadable body is not retryable — the request
          // succeeded, so a second identical one produces the same garbage.
          return {
            ok: false,
            body: null,
            error: `MX ${res.status}: response was not valid JSON`,
            status: res.status,
            attempts: attempt
          };
        }
      }
      lastStatus = res.status;
      lastError = await mxError(res);
    }

    if (!isRetryableStatus(lastStatus) || attempt === retry.attempts) break;
    if (signal?.aborted) break;

    const serverDelay = retryAfterMs(res);
    await sleep(Math.min(serverDelay ?? delay, retry.maxDelayMs), signal);
    delay *= 2;
  }

  return { ok: false, body: null, error: lastError, status: lastStatus, attempts: retry.attempts };
}

// ---------------------------------------------------------------------------
// Envelope handling
// ---------------------------------------------------------------------------

/**
 * Pull the next cursor out of a response envelope.
 *
 * Deliberately different from `extractWorkOrders` in `work-orders.ts`, which
 * does `nextCursor ?? nextPageUrl`. Those two are NOT interchangeable —
 * `nextPageUrl` is a full absolute URL, so feeding it to `?cursor=` sends
 * garbage. It has not bitten the serving path because `nextCursor` is always
 * present in practice, but an ingest walk that silently mis-paginates would
 * land a partial backfill and report success. So: prefer `nextCursor`, and
 * fall back to parsing the `cursor` param OUT of `nextPageUrl` rather than
 * passing the URL through whole.
 */
function extractCursor(obj: Record<string, unknown>): string | null {
  const direct = obj.nextCursor;
  if (typeof direct === "string" && direct !== "") return direct;

  const pageUrl = obj.nextPageUrl;
  if (typeof pageUrl === "string" && pageUrl !== "") {
    try {
      const parsed = new URL(pageUrl).searchParams.get("cursor");
      if (parsed) return parsed;
    } catch {
      // not a parseable URL — fall through to null
    }
  }
  return null;
}

/**
 * Pull rows out of a response envelope. The measured shape is
 * `{ workOrders | workRequests | comments, nextCursor, nextPageUrl }`, but the
 * serving client already tolerates `data` / `results` / a bare array and there
 * is no reason for ingest to be stricter.
 *
 * Rows without a usable numeric `id` are dropped: `id` is the upsert conflict
 * target on every `mx_*` table, so a row without one cannot be written
 * idempotently and would duplicate on every pass.
 */
function extractRows<T>(body: unknown, primaryKey: string): { rows: T[]; nextCursor: string | null } {
  if (!body || typeof body !== "object") return { rows: [], nextCursor: null };
  const obj = body as Record<string, unknown>;

  let arr: unknown = null;
  if (Array.isArray(obj)) arr = obj;
  else if (Array.isArray(obj[primaryKey])) arr = obj[primaryKey];
  else if (Array.isArray(obj.data)) arr = obj.data;
  else if (Array.isArray(obj.results)) arr = obj.results;

  const nextCursor = extractCursor(obj);
  if (!Array.isArray(arr)) return { rows: [], nextCursor };

  const rows: T[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number.parseInt(String(r.id ?? ""), 10);
    if (!Number.isFinite(id)) continue;
    rows.push(raw as T);
  }
  return { rows, nextCursor };
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

/** Common transport fields. */
interface SyncBase {
  apiKey: string;
  baseUrl: string;
  /** Caller-supplied AbortSignal so the cron handler can enforce its own
   *  wall-clock budget and stop mid-page. */
  signal?: AbortSignal;
  retry?: RetryOptions;
}

export interface FetchWorkOrderPageInput extends SyncBase {
  /** Opaque cursor from the previous page's `nextCursor`. Null/omitted starts
   *  a fresh walk. Verified: a cursor walk KEEPS any date/status filter
   *  applied across pages, with zero row overlap between consecutive pages —
   *  so a bounded walk can be resumed across invocations without silently
   *  widening. */
  cursor?: string | null;
  /** Defaults to 200, the API maximum. */
  limit?: number;
  /** Repeated `statuses=` params. MaintainX rejects the singular `status`
   *  outright. Omitted means MaintainX's own default, which is not the same
   *  as "all" — pass an explicit list. */
  statuses?: readonly string[];
  /** Defaults to `INGEST_EXPAND`. Pass `[]` for a bare payload. */
  expand?: readonly string[];
  sort?: WorkOrderSort;
  /** Repeated `locations=` params. Omit for the whole organization. */
  locations?: readonly number[];
  /** ISO 8601 UTC, e.g. `2026-03-13T00:00:00.000Z`. All four date bounds are
   *  verified working server-side — the incremental sweep depends on
   *  `updatedAtGte`, and Pass B's six-month history bound on `createdAtGte`.
   *
   *  One trap: `updatedAt` does NOT move when a comment is added, so an
   *  `updatedAtGte` sweep will miss comment-only activity. The comment pass
   *  is driven by `lastMessageSentAt` instead. */
  updatedAtGte?: string | null;
  updatedAtLte?: string | null;
  createdAtGte?: string | null;
  createdAtLte?: string | null;
}

export interface FetchWorkOrderPageResult {
  ok: boolean;
  workOrders: RawWorkOrder[];
  /** Null means the walk is exhausted — that is the pass-complete signal, and
   *  the ONLY one. There is no total-count field anywhere in the API. */
  nextCursor: string | null;
  error: string | null;
  status: number;
  attempts: number;
}

function applyDateBounds(url: URL, input: FetchWorkOrderPageInput): void {
  // Bracketed keys are literal, not a nested object: the wire form is
  // `updatedAt[gte]=2026-01-01T00:00:00.000Z`.
  if (input.updatedAtGte) url.searchParams.set("updatedAt[gte]", input.updatedAtGte);
  if (input.updatedAtLte) url.searchParams.set("updatedAt[lte]", input.updatedAtLte);
  if (input.createdAtGte) url.searchParams.set("createdAt[gte]", input.createdAtGte);
  if (input.createdAtLte) url.searchParams.set("createdAt[lte]", input.createdAtLte);
}

function buildWorkOrderUrl(input: FetchWorkOrderPageInput): string {
  const url = new URL(`${trimBase(input.baseUrl)}/workorders`);

  for (const status of input.statuses ?? []) {
    url.searchParams.append("statuses", status);
  }
  for (const token of input.expand ?? INGEST_EXPAND) {
    url.searchParams.append("expand", token);
  }
  for (const id of input.locations ?? []) {
    url.searchParams.append("locations", String(id));
  }

  url.searchParams.set("limit", String(Math.min(input.limit ?? INGEST_PAGE_LIMIT, INGEST_PAGE_LIMIT)));
  if (input.sort) url.searchParams.set("sort", input.sort);
  applyDateBounds(url, input);
  if (input.cursor) url.searchParams.set("cursor", input.cursor);

  return url.toString();
}

/**
 * Fetch exactly one page of work orders. One HTTP call (plus retries), no
 * accumulation, no iteration ceiling.
 *
 * The caller loops: fetch a page, upsert it, write `nextCursor` to
 * `mx_sync_state`, then decide whether to continue or return and let the next
 * cron tick resume. Checkpointing after EVERY page is the point — a timeout,
 * a CPU kill or a deploy mid-backfill then costs one page rather than the run.
 */
export async function fetchWorkOrderPage(
  input: FetchWorkOrderPageInput
): Promise<FetchWorkOrderPageResult> {
  const retry = { ...DEFAULT_RETRY, ...(input.retry ?? {}) };
  const res = await getJson(buildWorkOrderUrl(input), input.apiKey, input.signal, retry);

  if (!res.ok) {
    return {
      ok: false,
      workOrders: [],
      nextCursor: null,
      error: res.error,
      status: res.status,
      attempts: res.attempts
    };
  }

  const { rows, nextCursor } = extractRows<RawWorkOrder>(res.body, "workOrders");
  return { ok: true, workOrders: rows, nextCursor, error: null, status: res.status, attempts: res.attempts };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface FetchWorkOrderCommentsInput extends SyncBase {
  workOrderId: number;
  cursor?: string | null;
  limit?: number;
}

export interface FetchWorkOrderCommentsResult {
  ok: boolean;
  comments: RawWorkOrderComment[];
  nextCursor: string | null;
  error: string | null;
  status: number;
  attempts: number;
}

/**
 * Fetch one page of comments for a work order.
 *
 * This endpoint accepts ONLY `cursor` and `limit` — `expand` returns 400, so
 * do not add it looking for attachments. Comment photos are not retrievable
 * through the API at all (confirmed four ways in `mx-probe-comments-report.json`);
 * photo-only comments arrive with `content: ""` and have to render as a
 * MaintainX deep link.
 *
 * Call this ONLY for work orders where `type = 'REACTIVE'` and
 * `lastMessageSentAt` is set. Measured, that gate is 1,851 work orders against
 * ~20,000 — preventive work orders carry comments 0.2% of the time and are not
 * worth the request. Threads are short: mean 2.5 comments, max 6.
 */
export async function fetchWorkOrderComments(
  input: FetchWorkOrderCommentsInput
): Promise<FetchWorkOrderCommentsResult> {
  const retry = { ...DEFAULT_RETRY, ...(input.retry ?? {}) };

  const url = new URL(`${trimBase(input.baseUrl)}/workorders/${input.workOrderId}/comments`);
  url.searchParams.set("limit", String(Math.min(input.limit ?? INGEST_PAGE_LIMIT, INGEST_PAGE_LIMIT)));
  if (input.cursor) url.searchParams.set("cursor", input.cursor);

  const res = await getJson(url.toString(), input.apiKey, input.signal, retry);
  if (!res.ok) {
    return {
      ok: false,
      comments: [],
      nextCursor: null,
      error: res.error,
      status: res.status,
      attempts: res.attempts
    };
  }

  const { rows, nextCursor } = extractRows<RawWorkOrderComment>(res.body, "comments");
  return { ok: true, comments: rows, nextCursor, error: null, status: res.status, attempts: res.attempts };
}

// ---------------------------------------------------------------------------
// Work requests
// ---------------------------------------------------------------------------

export interface FetchWorkRequestPageInput extends SyncBase {
  cursor?: string | null;
  limit?: number;
  statuses?: readonly string[];
  locations?: readonly number[];
}

export interface FetchWorkRequestPageResult {
  ok: boolean;
  workRequests: RawWorkRequest[];
  nextCursor: string | null;
  error: string | null;
  status: number;
  attempts: number;
}

/**
 * Fetch one page of work requests.
 *
 * `/workrequests` has NO date filter and NO sort — only cursor, limit and a
 * few attribute filters. So incremental sync means re-walking all ~52 pages
 * and diffing locally. That is fine hourly and not fine every few minutes.
 */
export async function fetchWorkRequestPage(
  input: FetchWorkRequestPageInput
): Promise<FetchWorkRequestPageResult> {
  const retry = { ...DEFAULT_RETRY, ...(input.retry ?? {}) };

  const url = new URL(`${trimBase(input.baseUrl)}/workrequests`);
  for (const status of input.statuses ?? []) {
    url.searchParams.append("statuses", status);
  }
  for (const id of input.locations ?? []) {
    url.searchParams.append("locations", String(id));
  }
  url.searchParams.set("limit", String(Math.min(input.limit ?? INGEST_PAGE_LIMIT, INGEST_PAGE_LIMIT)));
  if (input.cursor) url.searchParams.set("cursor", input.cursor);

  const res = await getJson(url.toString(), input.apiKey, input.signal, retry);
  if (!res.ok) {
    return {
      ok: false,
      workRequests: [],
      nextCursor: null,
      error: res.error,
      status: res.status,
      attempts: res.attempts
    };
  }

  const { rows, nextCursor } = extractRows<RawWorkRequest>(res.body, "workRequests");
  return { ok: true, workRequests: rows, nextCursor, error: null, status: res.status, attempts: res.attempts };
}
