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

/** The row shape the widened select returns. Embedded resources come back as
 *  arrays, or absent when the parent has none. */
interface PgWorkOrderRow {
  raw: unknown;
  part_cost_cents?: number | null;
  expenditure_cents?: number | null;
  total_cost_cents?: number | null;
  labor_seconds?: number | null;
  mx_work_order_comment?: Array<{
    id: number | string;
    author_id: number | null;
    content: string | null;
    mx_created_at: string | null;
  }> | null;
  mx_work_order_part?: Array<{
    name: string | null;
    quantity_used: number | null;
    unit_cost_cents: number | null;
    line_total_cents: number | null;
  }> | null;
  mx_work_order_expenditure?: Array<{
    description: string | null;
    type: string | null;
    quantity: number | null;
    cost_per_unit_cents: number | null;
    row_total_cents: number | null;
  }> | null;
  mx_work_order_attachment?: Array<{
    id: number;
    file_name: string | null;
    mime_type: string | null;
    width: number | null;
    height: number | null;
    is_thumbnail: boolean | null;
    r2_key: string | null;
  }> | null;
}

/** Integer cents or null. Guards against a string arriving from PostgREST for
 *  a bigint column, which it does for values beyond JS's safe integer range --
 *  not reachable for money here, but the coercion is free. */
function cents(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function projectExtras(row: PgWorkOrderRow): PgWorkOrderExtras {
  const rawComments = Array.isArray(row.mx_work_order_comment)
    ? row.mx_work_order_comment
    : [];

  // A comment with no body is noise in the UI -- it renders as an empty
  // bubble attributed to someone, which reads like a bug.
  const comments: PgComment[] = rawComments
    .filter((c) => typeof c.content === "string" && c.content.trim() !== "")
    .map((c) => ({
      id: c.id,
      authorId: typeof c.author_id === "number" ? c.author_id : null,
      content: (c.content as string).trim(),
      createdAt: c.mx_created_at ?? null
    }));

  const parts: PgPartLine[] = (Array.isArray(row.mx_work_order_part) ? row.mx_work_order_part : [])
    .map((p) => ({
      name: p.name?.trim() || "(unnamed part)",
      quantity: cents(p.quantity_used),
      unitCostCents: cents(p.unit_cost_cents),
      lineTotalCents: cents(p.line_total_cents)
    }));

  const expenditures: PgExpenditureLine[] = (
    Array.isArray(row.mx_work_order_expenditure) ? row.mx_work_order_expenditure : []
  ).map((e) => ({
    description: e.description?.trim() || "(no description)",
    type: e.type ?? null,
    quantity: cents(e.quantity),
    costPerUnitCents: cents(e.cost_per_unit_cents),
    rowTotalCents: cents(e.row_total_cents)
  }));

  const attachments: PgAttachment[] = (
    Array.isArray(row.mx_work_order_attachment) ? row.mx_work_order_attachment : []
  )
    // Belt and braces: the query already filters on r2_key, but a servable
    // attachment is defined by having bytes and nothing else should decide it.
    .filter((a) => typeof a.r2_key === "string" && a.r2_key !== "")
    .map((a) => ({
      id: a.id,
      fileName: a.file_name,
      mimeType: a.mime_type,
      width: cents(a.width),
      height: cents(a.height),
      isThumbnail: a.is_thumbnail === true
    }));

  return {
    attachments,
    partCostCents: cents(row.part_cost_cents),
    expenditureCents: cents(row.expenditure_cents),
    totalCostCents: cents(row.total_cost_cents),
    laborSeconds: cents(row.labor_seconds),
    comments,
    parts,
    expenditures,
    // The embed asked for COMMENT_LIMIT; getting exactly that many back is the
    // only signal available that more exist, since an embedded resource
    // carries no count of its own.
    commentsTruncated: rawComments.length >= COMMENT_LIMIT
  };
}

/** PostgREST `in.(...)` needs the list inline. Ids are numbers we produced
 *  ourselves, never operator input, but they are still coerced through
 *  Number() at the boundary so a malformed value cannot reach the query. */
function inList(ids: readonly number[]): string {
  return ids
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .join(",");
}

/**
 * Total row count from PostgREST's Content-Range header.
 *
 * Shape is `<first>-<last>/<total>`, or `* /0` for an empty result. Returns
 * null when the header is missing or unparseable, which the caller treats as
 * "fall back to counting rows" rather than as an error.
 */
function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const total = header.slice(slash + 1).trim();
  if (total === "*" || total === "") return null;
  const n = Number(total);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function selectJson<T>(
  env: PgListEnv,
  url: string
): Promise<
  | { ok: true; rows: T[]; total: number | null }
  | { ok: false; error: string; status: number }
> {
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Accept: "application/json",
        // Asks PostgREST to report the FULL matching count in Content-Range,
        // not just how many rows it sent. See the truncation note below for
        // why counting the returned rows cannot work.
        Prefer: "count=exact"
      }
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `${res.status} ${(await res.text()).slice(0, 300)}`,
        status: res.status
      };
    }
    return {
      ok: true,
      rows: (await res.json()) as T[],
      total: parseContentRangeTotal(res.headers.get("content-range"))
    };
  } catch (err) {
    // status 0 mirrors the MaintainX client's convention for "never got an
    // answer", which handleList already maps to a 504.
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 0 };
  }
}

/**
 * Was this result cut short?
 *
 * MEASURED 2026-09-14, and the reason this is not a row count: PostgREST
 * enforces its own `db-max-rows` ceiling (1000 on this project) ON TOP of the
 * `limit` in the query. The obvious trick -- ask for cap+1 and treat the extra
 * row as proof of more -- therefore CANNOT FIRE at a cap of 1000, because the
 * 1001st row is exactly the one PostgREST refuses to send.
 *
 * It was caught by comparing the two sources for a real operator: MaintainX
 * reported truncated for 9 locations holding 1,042 active work orders and this
 * module reported not-truncated for the same 1,046 rows. The visible symptom
 * would have been the page quietly dropping the 46 oldest rows with no banner,
 * where the MaintainX path shows one -- silent loss, and only on the operators
 * with the most work.
 *
 * So truncation is decided by the authoritative count when we have one, and
 * only falls back to the row-length heuristic when the header is missing --
 * where it is still correct for any cap below db-max-rows.
 */
function isTruncated(total: number | null, returned: number, cap: number): boolean {
  if (total !== null) return total > cap;
  return returned > cap;
}

/** One comment, as the expanded row renders it. `authorId` is resolved to a
 *  name by the caller against the same maintainx_users cache the assignee
 *  list uses -- this module does no name resolution of its own. */
export interface PgComment {
  id: number | string;
  authorId: number | null;
  content: string;
  createdAt: string | null;
}

export interface PgPartLine {
  name: string;
  quantity: number | null;
  unitCostCents: number | null;
  lineTotalCents: number | null;
}

export interface PgExpenditureLine {
  description: string;
  type: string | null;
  quantity: number | null;
  costPerUnitCents: number | null;
  rowTotalCents: number | null;
}

/**
 * Everything the expanded row needs that is NOT in the MaintainX payload.
 *
 * Kept beside the work orders rather than merged into `raw` on purpose: raw is
 * what MaintainX sent, and quietly adding our own keys to it would make a
 * later reader unable to tell the two apart. The caller zips them by id.
 *
 * COMMENTS ARE THE REASON THIS IS WORTH HAVING. They are not on the work order
 * payload at all -- MaintainX serves them from a separate endpoint, one call
 * per work order, which is why the live path never showed them. Reading them
 * from the mirror costs nothing extra because they arrive in the same query.
 */
export interface PgAttachment {
  id: number;
  fileName: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  isThumbnail: boolean;
}

export interface PgWorkOrderExtras {
  partCostCents: number | null;
  expenditureCents: number | null;
  totalCostCents: number | null;
  laborSeconds: number | null;
  comments: PgComment[];
  parts: PgPartLine[];
  expenditures: PgExpenditureLine[];
  /** ONLY attachments whose bytes are already in R2. An un-mirrored one
   *  cannot be served -- its MaintainX URL expired an hour after the sync that
   *  saw it -- so surfacing it would render a broken image. */
  attachments: PgAttachment[];
  /** True when the comment list was capped -- see COMMENT_LIMIT. */
  commentsTruncated: boolean;
}

/**
 * Newest comments kept per work order.
 *
 * MEASURED 2026-09-14: 396 comments across every active work order
 * account-wide, so the cap is not about total volume. It is about the long
 * tail -- one work order carries 174 comments on its own, and an expanded row
 * that dumps 174 of anything is not readable. The newest are the ones an
 * operator opens the row to see; the rest stay one click away in MaintainX.
 */
const COMMENT_LIMIT = 20;

export interface PgWorkOrderResult {
  ok: boolean;
  workOrders: RawWorkOrder[];
  /** Keyed by work order id. Absent for a work order with no extras at all. */
  extrasById: Map<number, PgWorkOrderExtras>;
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
    return {
      ok: true,
      workOrders: [],
      extrasById: new Map(),
      truncated: false,
      pageCount: 1,
      error: null,
      status: 200
    };
  }

  // One query for the work orders AND everything the expanded row needs.
  // PostgREST resource embedding follows the foreign keys on
  // mx_work_order_comment / _part / _expenditure, so comments cost no extra
  // round trip -- which is the whole reason they can be shown at all. On the
  // MaintainX path they would be one API call PER WORK ORDER.
  const embed =
    `raw,part_cost_cents,expenditure_cents,total_cost_cents,labor_seconds,` +
    `mx_work_order_comment(id,author_id,content,mx_created_at),` +
    `mx_work_order_part(name,quantity_used,unit_cost_cents,line_total_cents),` +
    `mx_work_order_expenditure(description,type,quantity,cost_per_unit_cents,row_total_cents),` +
    `mx_work_order_attachment(id,file_name,mime_type,width,height,is_thumbnail,r2_key)`;

  const url =
    `${input.env.SUPABASE_URL}/rest/v1/mx_work_order` +
    `?select=${embed}` +
    // Newest comments first, capped per work order. The limit is applied to
    // the EMBEDDED resource, so it bounds each parent's list rather than the
    // result as a whole.
    `&mx_work_order_comment.order=mx_created_at.desc` +
    `&mx_work_order_comment.limit=${COMMENT_LIMIT}` +
    `&mx_work_order_part.order=ordinal.asc` +
    `&mx_work_order_expenditure.order=ordinal.asc` +
    // Only mirrored rows: an attachment without bytes in R2 has no servable
    // source, so including it would render a broken image in the expanded row.
    `&mx_work_order_attachment.r2_key=not.is.null` +
    `&mx_work_order_attachment.order=is_thumbnail.desc,mx_created_at.asc` +
    `&status=in.(${ACTIVE_STATUSES.join(",")})` +
    `&deleted_at=is.null` +
    `&mx_location_id=in.(${ids})` +
    // Newest-touched first, so a truncated result keeps the rows an operator
    // is most likely to be looking for -- the same bias as the MaintainX
    // path's `sort=-updatedAt`.
    `&order=mx_updated_at.desc.nullslast` +
    `&limit=${cap + 1}`;

  const res = await selectJson<PgWorkOrderRow>(input.env, url);
  if (!res.ok) {
    return {
      ok: false,
      workOrders: [],
      extrasById: new Map(),
      truncated: false,
      pageCount: 1,
      error: res.error,
      status: res.status
    };
  }

  const truncated = isTruncated(res.total, res.rows.length, cap);
  const rows = res.rows.length > cap ? res.rows.slice(0, cap) : res.rows;

  // A row whose raw is null or not an object is unusable. It should not
  // happen -- the ingest writes raw on every upsert -- but dropping it beats
  // handing the projection something it will read undefined fields off.
  const workOrders: RawWorkOrder[] = [];
  const extrasById = new Map<number, PgWorkOrderExtras>();
  let skipped = 0;
  for (const row of rows) {
    if (!row.raw || typeof row.raw !== "object" || Array.isArray(row.raw)) {
      skipped += 1;
      continue;
    }
    const wo = row.raw as RawWorkOrder;
    workOrders.push(wo);

    const id = typeof wo.id === "number" ? wo.id : null;
    if (id !== null) extrasById.set(id, projectExtras(row));
  }
  if (skipped > 0) {
    console.error(`[mx-pg] dropped ${skipped} work order row(s) with unusable raw payload`);
  }

  return { ok: true, workOrders, extrasById, truncated, pageCount: 1, error: null, status: 200 };
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

  const truncated = isTruncated(res.total, res.rows.length, cap);
  const rows = res.rows.length > cap ? res.rows.slice(0, cap) : res.rows;

  const workRequests: RawWorkRequest[] = [];
  for (const row of rows) {
    if (row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)) {
      workRequests.push(row.raw as RawWorkRequest);
    }
  }

  return { ok: true, workRequests, truncated, pageCount: 1, error: null, status: 200 };
}
