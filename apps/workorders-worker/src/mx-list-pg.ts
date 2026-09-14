// Postgres-backed source for the /workorders read path.
//
// WHY THIS IS SHAPED LIKE THE MAINTAINX CLIENT
//
//   These two functions return the same result shape as
//   fetchMaintainXWorkOrders / fetchMaintainXWorkRequests, and they return
//   RawWorkOrder / RawWorkRequest objects -- not a new projection. That is the
//   whole design. handleList's bucketing, grouping, assignee resolution,
//   preventive-overdue filter, location-name harvesting and projection all
//   stay byte-for-byte the code that serves MaintainX today, so flipping the
//   source cannot change the response shape. apps/web needs no change, and the
//   two sources can be compared field by field on live traffic.
//
//   The alternative -- projecting straight from the typed columns -- would be
//   faster and would also mean reimplementing every one of those steps against
//   a second set of field names, with no way to prove the two agreed. Fidelity
//   beats efficiency here; see the note on `raw` below for why the cost is
//   small anyway.
//
// WHY `raw` AND NOT THE TYPED COLUMNS
//
//   mx_work_order.raw holds the MaintainX payload the ingest wrote, including
//   the expanded `location`, `assignees` and `categories` the projection
//   reads. MEASURED 2026-09-14: it averages ~1 KB a row and 4.1 MB for all
//   3,984 active work orders account-wide -- and a request only ever selects
//   one operator's locations, a small fraction of that.
//
//   `categories` is the one column the webhook path deliberately does not
//   write (there is no single-entity expand for it, and sending an empty array
//   would blank what the poller got right). That raised the question of
//   whether raw's copy had been degraded instead. MEASURED across all 3,984
//   active rows: 1 differs, and in the direction where raw has categories the
//   column lacks. So raw is equal-or-better and is what we serve.
//
// WHAT THIS DOES NOT DO
//
//   No permission decisions. The caller resolves which MaintainX location ids
//   an operator may see -- exactly as it does for the MaintainX path -- and
//   passes them in. This module filters to the ids it is given and nothing
//   else, so there is one permission model rather than two.

import type { RawWorkOrder, RawWorkRequest } from "@splash/maintainx";

export interface PgListEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

/**
 * Statuses the operator page surfaces, mirroring ACTIVE_STATUSES in
 * packages/maintainx. Kept as its own constant rather than imported because
 * the MaintainX one is shaped for a query string; if the two ever need to
 * differ, that should be a visible edit here and not a silent divergence.
 */
const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "ON_HOLD"] as const;

/** Mirrors REQUEST_VISIBLE_STATUSES in index.ts (Brief 80). */
const REQUEST_STATUSES = ["PENDING", "REJECTED"] as const;

/**
 * Row ceilings, matching MAX_WORK_ORDERS_MULTI / MAX_WORK_REQUESTS on the
 * MaintainX path. These are only fallbacks -- handleList passes its own -- but
 * they match so a future caller that omits the argument cannot quietly get a
 * different truncation point than the source it is replacing.
 *
 * We ask for one MORE row than the cap: getting it back is how truncation is
 * detected without a second count query.
 *
 * Worth noting for later: the caps exist because of MaintainX's paging, not
 * ours. A single-location operator is capped at 200 here purely to match what
 * the live path does today, and Postgres could serve the full set in one
 * query. Raising it is an easy win AFTER the cutover -- doing it during would
 * mean the two sources disagree, which is exactly what the comparison period
 * needs to rule out.
 */
const MAX_ROWS = 1000;
const MAX_REQUEST_ROWS = 1000;

/** PostgREST `in.(...)` needs the list inline. Ids are numbers we produced
 *  ourselves, never operator input, but they are still coerced through
 *  Number() at the boundary so a malformed value cannot reach the query. */
function inList(ids: readonly number[]): string {
  return ids
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .join(",");
}

async function selectJson<T>(
  env: PgListEnv,
  url: string
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Accept: "application/json"
      }
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `${res.status} ${(await res.text()).slice(0, 300)}`,
        status: res.status
      };
    }
    return { ok: true, rows: (await res.json()) as T[] };
  } catch (err) {
    // status 0 mirrors the MaintainX client's convention for "never got an
    // answer", which handleList already maps to a 504.
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 0 };
  }
}

export interface PgWorkOrderResult {
  ok: boolean;
  workOrders: RawWorkOrder[];
  truncated: boolean;
  /** Always 1: one round trip, whatever the row count. Kept so the response
   *  field stays populated and comparable with the MaintainX path's call
   *  count, which is the number this replaces. */
  pageCount: number;
  error: string | null;
  status: number;
}

/**
 * Active work orders for the given MaintainX location ids.
 *
 * `deleted_at is null` is load-bearing: soft-deleted rows keep their last
 * known status, so a work order deleted while OPEN stays OPEN in the column
 * and would otherwise reappear on the page after the webhook correctly
 * recorded it as gone.
 */
export async function fetchWorkOrdersFromPg(input: {
  env: PgListEnv;
  maintainxLocationIds: readonly number[];
  maxWorkOrders?: number;
}): Promise<PgWorkOrderResult> {
  const cap = input.maxWorkOrders ?? MAX_ROWS;
  const ids = inList(input.maintainxLocationIds);
  if (ids === "") {
    return { ok: true, workOrders: [], truncated: false, pageCount: 1, error: null, status: 200 };
  }

  const url =
    `${input.env.SUPABASE_URL}/rest/v1/mx_work_order` +
    `?select=raw` +
    `&status=in.(${ACTIVE_STATUSES.join(",")})` +
    `&deleted_at=is.null` +
    `&mx_location_id=in.(${ids})` +
    // Newest-touched first, so a truncated result keeps the rows an operator
    // is most likely to be looking for -- the same bias as the MaintainX
    // path's `sort=-updatedAt`.
    `&order=mx_updated_at.desc.nullslast` +
    `&limit=${cap + 1}`;

  const res = await selectJson<{ raw: unknown }>(input.env, url);
  if (!res.ok) {
    return {
      ok: false,
      workOrders: [],
      truncated: false,
      pageCount: 1,
      error: res.error,
      status: res.status
    };
  }

  const truncated = res.rows.length > cap;
  const rows = truncated ? res.rows.slice(0, cap) : res.rows;

  // A row whose raw is null or not an object is unusable. It should not
  // happen -- the ingest writes raw on every upsert -- but dropping it beats
  // handing the projection something it will read undefined fields off.
  const workOrders: RawWorkOrder[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)) {
      workOrders.push(row.raw as RawWorkOrder);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.error(`[mx-pg] dropped ${skipped} work order row(s) with unusable raw payload`);
  }

  return { ok: true, workOrders, truncated, pageCount: 1, error: null, status: 200 };
}

export interface PgWorkRequestResult {
  ok: boolean;
  workRequests: RawWorkRequest[];
  truncated: boolean;
  pageCount: number;
  error: string | null;
  status: number;
}

/**
 * Work requests in the two statuses the Requests tab surfaces.
 *
 * The status filter is applied here AND again by the caller, deliberately.
 * That mirrors the MaintainX path, where the caller re-applies it as
 * defense-in-depth rather than trusting an upstream query param.
 */
export async function fetchWorkRequestsFromPg(input: {
  env: PgListEnv;
  maintainxLocationIds: readonly number[];
  maxWorkRequests?: number;
}): Promise<PgWorkRequestResult> {
  const cap = input.maxWorkRequests ?? MAX_REQUEST_ROWS;
  const ids = inList(input.maintainxLocationIds);
  if (ids === "") {
    return { ok: true, workRequests: [], truncated: false, pageCount: 1, error: null, status: 200 };
  }

  const url =
    `${input.env.SUPABASE_URL}/rest/v1/mx_work_request` +
    `?select=raw` +
    `&request_status=in.(${REQUEST_STATUSES.join(",")})` +
    `&mx_location_id=in.(${ids})` +
    `&order=mx_created_at.desc.nullslast` +
    `&limit=${cap + 1}`;

  const res = await selectJson<{ raw: unknown }>(input.env, url);
  if (!res.ok) {
    return {
      ok: false,
      workRequests: [],
      truncated: false,
      pageCount: 1,
      error: res.error,
      status: res.status
    };
  }

  const truncated = res.rows.length > cap;
  const rows = truncated ? res.rows.slice(0, cap) : res.rows;

  const workRequests: RawWorkRequest[] = [];
  for (const row of rows) {
    if (row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)) {
      workRequests.push(row.raw as RawWorkRequest);
    }
  }

  return { ok: true, workRequests, truncated, pageCount: 1, error: null, status: 200 };
}
