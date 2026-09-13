// Supabase write helpers for the MaintainX -> Postgres ingest (`mx_*` tables).
//
// Companion to `packages/maintainx/src/sync.ts`, which does the reading. That
// module hands back raw MaintainX page payloads; the worker maps them to the
// row shapes declared here; this module writes them.
//
// Conventions, all inherited deliberately from `maintainx-users.ts`:
//
//   - Raw `fetch` against PostgREST. No `@supabase/supabase-js` client, so
//     there is no session, no RLS negotiation and no extra bundle weight.
//   - NOTHING HERE THROWS. Every export returns `{ ok, ... , error }`. An
//     unchecked `.ok` is a silently swallowed write failure, and in a chunked
//     backfill that means a checkpoint advancing past rows that never landed.
//   - `env` is `{ SUPABASE_URL, SUPABASE_SERVICE_KEY }`, passed explicitly.
//
// Three write shapes appear below, because the API gives us three different
// kinds of identity:
//
//   1. STABLE ID  -> plain upsert on `id`.
//      mx_work_order, mx_work_order_comment, mx_work_request.
//
//   2. STABLE COMPOSITE -> upsert on (work_order_id, part_id), then delete the
//      rows that are no longer on the work order.
//      mx_work_order_part.
//
//   3. NO ID AT ALL -> read, delete, re-insert.
//      mx_work_order_expenditure, mx_work_order_time_item. MaintainX returns
//      these as bare arrays with no identifier, and ordinals shift whenever
//      somebody deletes an earlier line, so ordinal is not an idempotency key.
//      The read step exists purely to carry `first_seen_at` forward: that
//      column is the business date the expense-posting flow keys on, and a
//      naive delete-and-replace would reset it to now() on every single sync.

const HEADERS = (env: { SUPABASE_SERVICE_KEY: string }) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

export interface SupabaseWriteEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

/** Upsert chunk sizes. Work-order rows carry `raw` jsonb and are fat; comments
 *  are four scalar columns and are not. */
export const MX_WORK_ORDER_BATCH = 200;
export const MX_COMMENT_BATCH = 500;
export const MX_WORK_REQUEST_BATCH = 200;

/** Truncation ceiling for PostgREST error bodies kept in a result object. */
export const MX_ERROR_BODY_MAX = 1024;

export interface MxWriteResult {
  ok: boolean;
  /** Rows handed to PostgREST. Not a server-confirmed count: the upserts use
   *  `return=minimal`, which is what makes them cheap. */
  written: number;
  requests: number;
  status: number;
  error: string | null;
}

function emptyResult(): MxWriteResult {
  return { ok: true, written: 0, requests: 0, status: 0, error: null };
}

// ---------------------------------------------------------------------------
// Row shapes
//
// These mirror the columns in `supabase/maintainx-ingest-01-tables.sql`. Every
// field is optional except the keys, because MaintainX OMITS null fields from
// its responses rather than sending them as null -- so the mapper must be free
// to emit a partial row. Columns the DB defaults (first_seen_at, synced_at,
// and the `not null default` rollups) are deliberately absent from most of
// these types; pass them only when you mean to override the default.
// ---------------------------------------------------------------------------

export interface MxWorkOrderRow {
  id: number;
  sequential_id?: number | null;
  organization_id?: number | null;

  title?: string | null;
  description?: string | null;
  work_order_summary?: string | null;

  status?: string | null;
  part_status?: string | null;
  priority?: string | null;
  type?: string | null;

  mx_location_id?: number | null;
  location_id?: number | null;
  site_number?: number | null;

  asset_id?: number | null;
  parent_id?: number | null;
  next_id?: number | null;
  previous_id?: number | null;
  is_parent?: boolean;

  creator_id?: number | null;
  completer_id?: number | null;
  requester_id?: number | null;
  customer_id?: number | null;

  assignee_ids?: number[];
  team_ids?: number[];
  vendor_ids?: number[];
  categories?: unknown;

  estimated_time_seconds?: number | null;
  due_date?: string | null;
  due_date_is_full_day?: boolean | null;
  start_date?: string | null;
  completed_at?: string | null;

  mx_created_at?: string | null;
  mx_updated_at?: string | null;
  deleted_at?: string | null;
  last_message_sent_at?: string | null;

  procedure_id?: number | null;
  procedure_title?: string | null;
  thumbnail_attachment_id?: number | null;

  progress?: unknown;
  extra_fields?: unknown;
  external_data?: unknown;

  part_cost_cents?: number;
  expenditure_cents?: number;
  labor_seconds?: number;
  labor_cost_cents?: number;
  total_cost_cents?: number;
  comment_count?: number;
  attachment_count?: number;

  raw?: unknown;
  synced_at?: string;
}

export interface MxWorkOrderCommentRow {
  id: number;
  work_order_id: number;
  author_id?: number | null;
  content?: string | null;
  mx_created_at?: string | null;
  synced_at?: string;
}

export interface MxWorkRequestRow {
  id: number;
  work_order_id?: number | null;

  request_status?: string | null;
  title?: string | null;
  description?: string | null;
  priority?: string | null;

  mx_location_id?: number | null;
  location_id?: number | null;
  site_number?: number | null;
  asset_id?: number | null;

  creator_id?: number | null;
  creator_contact_type?: string | null;
  creator_contact_value?: string | null;
  requester_email?: string | null;
  approver_team_id?: number | null;

  mx_created_at?: string | null;
  mx_updated_at?: string | null;

  extra_fields?: unknown;
  raw?: unknown;
  synced_at?: string;
}

/** `line_total_cents` is a generated column -- sending it is a PostgREST 400. */
export interface MxWorkOrderPartRow {
  work_order_id: number;
  part_id: number;
  ordinal: number;

  name?: string | null;
  description?: string | null;
  area?: string | null;
  barcode?: string | null;
  copy_on_recurring?: string | null;

  quantity_used?: number;
  unit_cost_cents?: number;

  available_quantity?: number | null;
  minimum_quantity?: number | null;
  part_location_id?: number | null;
  part_extra_fields?: unknown;

  synced_at?: string;
}

export interface MxWorkOrderExpenditureRow {
  work_order_id: number;
  ordinal: number;
  dedupe_key: string;
  occurrence?: number;

  type?: string | null;
  description?: string | null;
  user_id?: number | null;
  quantity?: number;
  cost_per_unit_cents?: number;
  row_total_cents?: number;

  /** Set by `replaceMxWorkOrderExpenditures` from the pre-delete snapshot.
   *  Callers should leave it undefined and let the helper carry it. */
  first_seen_at?: string;
  synced_at?: string;
}

export interface MxWorkOrderTimeItemRow {
  work_order_id: number;
  ordinal: number;

  type?: string | null;
  user_id?: number | null;
  quantity_hours?: number;
  duration_total_seconds?: number;

  first_seen_at?: string;
  synced_at?: string;
}

// ---------------------------------------------------------------------------
// Low-level PostgREST plumbing
// ---------------------------------------------------------------------------

interface RestResult {
  ok: boolean;
  status: number;
  body: string;
  error: string | null;
}

async function rest(
  env: SupabaseWriteEnv,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  params: Record<string, string>,
  init?: { body?: unknown; prefer?: string }
): Promise<RestResult> {
  let url: URL;
  try {
    url = new URL(`/rest/v1/${path}`, env.SUPABASE_URL);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: "",
      error: `bad SUPABASE_URL: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = { ...HEADERS(env) };
  if (init?.prefer) headers.Prefer = init.prefer;
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body)
    });
  } catch (err) {
    // Network-level failure: no status to report, so 0 signals "never reached
    // PostgREST" as distinct from a 4xx/5xx that did.
    return {
      ok: false,
      status: 0,
      body: "",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  let body = "";
  try {
    body = await response.text();
  } catch {
    // A 2xx whose body we cannot read is still a successful write; only the
    // GET helpers care about the body, and they check `ok` before parsing.
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body,
      error: `${response.status}: ${body.slice(0, MX_ERROR_BODY_MAX)}`
    };
  }
  return { ok: true, status: response.status, body, error: null };
}

/** Upsert `rows` into `table` in chunks, conflicting on `onConflict`.
 *  Stops at the first failing chunk and reports how many rows made it. */
async function upsertInBatches(
  env: SupabaseWriteEnv,
  table: string,
  onConflict: string,
  rows: unknown[],
  batchSize: number
): Promise<MxWriteResult> {
  if (rows.length === 0) return emptyResult();

  let written = 0;
  let requests = 0;
  let status = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const r = await rest(env, "POST", table, { on_conflict: onConflict }, {
      body: chunk,
      prefer: "resolution=merge-duplicates,return=minimal"
    });
    requests += 1;
    status = r.status;
    if (!r.ok) {
      return { ok: false, written, requests, status, error: r.error };
    }
    written += chunk.length;
  }

  return { ok: true, written, requests, status, error: null };
}

/** PostgREST `in.(...)` list. Empty stays empty -- callers must not build a
 *  `not.in.()` filter from it, because PostgREST rejects the empty form. */
function inList(values: Array<number | string>): string {
  return `(${values.join(",")})`;
}

// ---------------------------------------------------------------------------
// 1. Stable-id upserts
// ---------------------------------------------------------------------------

export function upsertMxWorkOrders(
  env: SupabaseWriteEnv,
  rows: MxWorkOrderRow[]
): Promise<MxWriteResult> {
  return upsertInBatches(env, "mx_work_order", "id", rows, MX_WORK_ORDER_BATCH);
}

export function upsertMxWorkOrderComments(
  env: SupabaseWriteEnv,
  rows: MxWorkOrderCommentRow[]
): Promise<MxWriteResult> {
  return upsertInBatches(env, "mx_work_order_comment", "id", rows, MX_COMMENT_BATCH);
}

export function upsertMxWorkRequests(
  env: SupabaseWriteEnv,
  rows: MxWorkRequestRow[]
): Promise<MxWriteResult> {
  return upsertInBatches(env, "mx_work_request", "id", rows, MX_WORK_REQUEST_BATCH);
}

// ---------------------------------------------------------------------------
// 2. Parts: stable composite key, so upsert then prune
// ---------------------------------------------------------------------------

/** Upserts the parts currently on `workOrderId` and deletes any row for a part
 *  that is no longer listed. Two requests, or one when the list is empty. */
export async function replaceMxWorkOrderParts(
  env: SupabaseWriteEnv,
  workOrderId: number,
  rows: MxWorkOrderPartRow[]
): Promise<MxWriteResult> {
  let requests = 0;
  let status = 0;

  if (rows.length > 0) {
    const up = await upsertInBatches(
      env,
      "mx_work_order_part",
      "work_order_id,part_id",
      rows,
      MX_WORK_ORDER_BATCH
    );
    requests += up.requests;
    status = up.status;
    if (!up.ok) return { ...up, requests, status };
  }

  const keep = rows.map((r) => r.part_id);
  const filter: Record<string, string> = { work_order_id: `eq.${workOrderId}` };
  if (keep.length > 0) filter.part_id = `not.in.${inList(keep)}`;

  const del = await rest(env, "DELETE", "mx_work_order_part", filter, {
    prefer: "return=minimal"
  });
  requests += 1;
  status = del.status;
  if (!del.ok) {
    return { ok: false, written: rows.length, requests, status, error: del.error };
  }

  return { ok: true, written: rows.length, requests, status, error: null };
}

// ---------------------------------------------------------------------------
// 3. Idless children: snapshot, delete, re-insert
// ---------------------------------------------------------------------------

/** Reads `select` for one work order and returns the parsed rows.
 *  Fails soft: an unparseable body is reported, not thrown. */
async function selectChildren(
  env: SupabaseWriteEnv,
  table: string,
  workOrderId: number,
  select: string
): Promise<{ ok: boolean; rows: Record<string, unknown>[]; status: number; error: string | null }> {
  const r = await rest(env, "GET", table, {
    select,
    work_order_id: `eq.${workOrderId}`
  });
  if (!r.ok) return { ok: false, rows: [], status: r.status, error: r.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body);
  } catch (err) {
    return {
      ok: false,
      rows: [],
      status: r.status,
      error: `unparseable body: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, rows: [], status: r.status, error: "expected an array" };
  }
  return {
    ok: true,
    rows: parsed.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null),
    status: r.status,
    error: null
  };
}

/**
 * Content key for a time item. Time items, like expenditures, come back with
 * no id -- but unlike expenditures they carry no `dedupe_key` column either,
 * so `first_seen_at` is carried forward on this synthesised key instead.
 */
function timeItemKey(row: MxWorkOrderTimeItemRow): string {
  return [
    row.type ?? "",
    row.user_id ?? "",
    row.quantity_hours ?? 0,
    row.duration_total_seconds ?? 0
  ].join("|");
}

/**
 * Delete-and-replace `mx_work_order_expenditure` for one work order, carrying
 * `first_seen_at` forward by `dedupe_key`.
 *
 * Why not a plain upsert on the (work_order_id, dedupe_key) unique index: the
 * primary key is (work_order_id, ordinal), and ordinals shift when an earlier
 * line is deleted. An upsert matching on dedupe_key would then try to move a
 * surviving row onto an ordinal another row still holds, and the statement
 * fails on the primary key. Clearing the work order first sidesteps that
 * entirely, at the cost of one extra read to preserve the business date.
 *
 * Three requests per work order. Measured production usage is expenditures on
 * ~0.1% of work orders, so this is not the hot path.
 */
export async function replaceMxWorkOrderExpenditures(
  env: SupabaseWriteEnv,
  workOrderId: number,
  rows: MxWorkOrderExpenditureRow[]
): Promise<MxWriteResult> {
  let requests = 0;
  let status = 0;

  const snap = await selectChildren(
    env,
    "mx_work_order_expenditure",
    workOrderId,
    "dedupe_key,first_seen_at"
  );
  requests += 1;
  status = snap.status;
  if (!snap.ok) {
    return { ok: false, written: 0, requests, status, error: snap.error };
  }

  const seenAt = new Map<string, string>();
  for (const row of snap.rows) {
    const key = row.dedupe_key;
    const at = row.first_seen_at;
    if (typeof key === "string" && typeof at === "string") seenAt.set(key, at);
  }

  const del = await rest(env, "DELETE", "mx_work_order_expenditure", {
    work_order_id: `eq.${workOrderId}`
  }, { prefer: "return=minimal" });
  requests += 1;
  status = del.status;
  if (!del.ok) {
    return { ok: false, written: 0, requests, status, error: del.error };
  }

  if (rows.length === 0) {
    return { ok: true, written: 0, requests, status, error: null };
  }

  const payload = rows.map((row) => {
    const carried = seenAt.get(row.dedupe_key);
    return carried ? { ...row, first_seen_at: carried } : row;
  });

  const ins = await rest(env, "POST", "mx_work_order_expenditure", {}, {
    body: payload,
    prefer: "return=minimal"
  });
  requests += 1;
  status = ins.status;
  if (!ins.ok) {
    return { ok: false, written: 0, requests, status, error: ins.error };
  }

  return { ok: true, written: rows.length, requests, status, error: null };
}

/** Same shape as the expenditure replace, keyed on synthesised content instead
 *  of a stored `dedupe_key`. See `timeItemKey`. */
export async function replaceMxWorkOrderTimeItems(
  env: SupabaseWriteEnv,
  workOrderId: number,
  rows: MxWorkOrderTimeItemRow[]
): Promise<MxWriteResult> {
  let requests = 0;
  let status = 0;

  const snap = await selectChildren(
    env,
    "mx_work_order_time_item",
    workOrderId,
    "type,user_id,quantity_hours,duration_total_seconds,first_seen_at"
  );
  requests += 1;
  status = snap.status;
  if (!snap.ok) {
    return { ok: false, written: 0, requests, status, error: snap.error };
  }

  const seenAt = new Map<string, string>();
  for (const row of snap.rows) {
    const at = row.first_seen_at;
    if (typeof at !== "string") continue;
    const key = timeItemKey({
      work_order_id: workOrderId,
      ordinal: 0,
      type: typeof row.type === "string" ? row.type : null,
      user_id: typeof row.user_id === "number" ? row.user_id : null,
      quantity_hours: Number(row.quantity_hours ?? 0),
      duration_total_seconds: Number(row.duration_total_seconds ?? 0)
    });
    if (!seenAt.has(key)) seenAt.set(key, at);
  }

  const del = await rest(env, "DELETE", "mx_work_order_time_item", {
    work_order_id: `eq.${workOrderId}`
  }, { prefer: "return=minimal" });
  requests += 1;
  status = del.status;
  if (!del.ok) {
    return { ok: false, written: 0, requests, status, error: del.error };
  }

  if (rows.length === 0) {
    return { ok: true, written: 0, requests, status, error: null };
  }

  const payload = rows.map((row) => {
    const carried = seenAt.get(timeItemKey(row));
    return carried ? { ...row, first_seen_at: carried } : row;
  });

  const ins = await rest(env, "POST", "mx_work_order_time_item", {}, {
    body: payload,
    prefer: "return=minimal"
  });
  requests += 1;
  status = ins.status;
  if (!ins.ok) {
    return { ok: false, written: 0, requests, status, error: ins.error };
  }

  return { ok: true, written: rows.length, requests, status, error: null };
}

// ---------------------------------------------------------------------------
// 4. Sync state
//
// One row per pass. The chunked backfill writes `cursor` after EVERY page, so
// an invocation that runs out of CPU resumes on the next tick instead of
// restarting the walk. `watermark` is the incremental sweep's high-water mark
// and must only advance once a pass completes -- advancing it mid-pass would
// permanently skip whatever the interrupted pass had not reached.
// ---------------------------------------------------------------------------

/**
 * `EMPTY` = the pass completed (null cursor) but walked exactly one page and
 * wrote zero rows. That shape is indistinguishable from a healthy finished
 * pass, which is how the MaintainX CANCELED+SKIPPED empty-200 bug stayed
 * invisible; recording it separately makes it visible in `mx_sync_state`.
 *
 * It is NOT a failure and must NOT trigger a retry — an incremental sweep that
 * finds no updated work orders is routine and will report EMPTY constantly.
 * `isComplete()` keys off `cursor` + `last_success_at`, never off this field,
 * so adding the member changes no control flow.
 *
 * The column is plain `text` with no CHECK constraint (see
 * supabase/maintainx-ingest-01-tables.sql), so no migration is needed.
 */
export type MxSyncStatus = "OK" | "PARTIAL" | "ERROR" | "EMPTY";

export interface MxSyncStateRow {
  key: string;
  watermark: string | null;
  cursor: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: MxSyncStatus | null;
  last_error: string | null;
  stats: Record<string, unknown>;
  updated_at: string | null;
}

export interface MxSyncStatePatch {
  watermark?: string | null;
  cursor?: string | null;
  last_run_at?: string | null;
  last_success_at?: string | null;
  last_status?: MxSyncStatus | null;
  last_error?: string | null;
  stats?: Record<string, unknown>;
}

export interface MxSyncStateResult {
  ok: boolean;
  state: MxSyncStateRow | null;
  status: number;
  error: string | null;
}

/** Reads one sync-state row. A missing row is `{ ok: true, state: null }` --
 *  that is the normal first-run condition, not an error. */
export async function getMxSyncState(
  env: SupabaseWriteEnv,
  key: string
): Promise<MxSyncStateResult> {
  const r = await rest(env, "GET", "mx_sync_state", {
    select: "*",
    key: `eq.${key}`,
    limit: "1"
  });
  if (!r.ok) return { ok: false, state: null, status: r.status, error: r.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body);
  } catch (err) {
    return {
      ok: false,
      state: null,
      status: r.status,
      error: `unparseable body: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: true, state: null, status: r.status, error: null };
  }

  const row = parsed[0] as Record<string, unknown>;
  return {
    ok: true,
    status: r.status,
    error: null,
    state: {
      key,
      watermark: typeof row.watermark === "string" ? row.watermark : null,
      cursor: typeof row.cursor === "string" ? row.cursor : null,
      last_run_at: typeof row.last_run_at === "string" ? row.last_run_at : null,
      last_success_at: typeof row.last_success_at === "string" ? row.last_success_at : null,
      last_status: typeof row.last_status === "string" ? (row.last_status as MxSyncStatus) : null,
      last_error: typeof row.last_error === "string" ? row.last_error : null,
      stats:
        typeof row.stats === "object" && row.stats !== null
          ? (row.stats as Record<string, unknown>)
          : {},
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null
    }
  };
}

/**
 * Upserts one sync-state row. Only the keys present in `patch` are sent, so a
 * checkpoint write that omits `watermark` leaves the stored watermark alone.
 *
 * Note the asymmetry with MaintainX's own payloads: here an explicit `null` IS
 * meaningful and clears the column -- that is how a completed pass clears its
 * cursor. Omission means "leave it"; null means "clear it".
 */
export async function writeMxSyncState(
  env: SupabaseWriteEnv,
  key: string,
  patch: MxSyncStatePatch
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const row: Record<string, unknown> = { key, updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) row[k] = v;
  }

  const r = await rest(env, "POST", "mx_sync_state", { on_conflict: "key" }, {
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal"
  });
  return { ok: r.ok, status: r.status, error: r.error };
}

// ---------------------------------------------------------------------------
// 5. Location resolution
//
// `mx_location_id` is authoritative on every mx_* row and is written
// unconditionally. `location_id` and `site_number` are denormalised at ingest
// time purely so downstream reporting can join without a round trip, and they
// are ALLOWED to be null: a MaintainX location with no `locations.maintainx_id`
// counterpart still gets its work orders ingested. Dropping a row because a
// mapping is missing would silently hide a whole site.
// ---------------------------------------------------------------------------

export interface MxLocationMapping {
  /** `locations.id` — the FK target on mx_work_order.location_id. */
  locationId: number;
  /** `locations.site_number` — the business key labour budgets are keyed on. */
  siteNumber: number | null;
}

export interface MxLocationMapResult {
  ok: boolean;
  /** Keyed by MaintainX location id. Empty on failure, never partial. */
  map: Map<number, MxLocationMapping>;
  status: number;
  error: string | null;
}

/**
 * Loads the whole `maintainx_id -> {locations.id, site_number}` mapping in one
 * request. Intended to be fetched once per invocation and passed into the
 * mapper for every page, rather than looked up per work order.
 */
export async function fetchMxLocationMap(
  env: SupabaseWriteEnv
): Promise<MxLocationMapResult> {
  const r = await rest(env, "GET", "locations", {
    select: "id,site_number,maintainx_id",
    maintainx_id: "not.is.null"
  });
  if (!r.ok) return { ok: false, map: new Map(), status: r.status, error: r.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body);
  } catch (err) {
    return {
      ok: false,
      map: new Map(),
      status: r.status,
      error: `unparseable body: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, map: new Map(), status: r.status, error: "expected an array" };
  }

  const map = new Map<number, MxLocationMapping>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const mxId = row.maintainx_id;
    const locId = row.id;
    if (typeof mxId !== "number" || !Number.isFinite(mxId)) continue;
    if (typeof locId !== "number" || !Number.isFinite(locId)) continue;
    map.set(mxId, {
      locationId: locId,
      siteNumber: typeof row.site_number === "number" ? row.site_number : null
    });
  }

  return { ok: true, map, status: r.status, error: null };
}

// ---------------------------------------------------------------------------
// 6. Page-scoped child writes
//
// The per-work-order helpers above are the right shape for the webhook path,
// which handles one id at a time. They are the WRONG shape for a backfill.
//
// Time items land on ~21% of work orders. At 200 work orders per page that is
// ~42 work orders x 3 requests = ~126 subrequests for time items alone, on a
// platform that allows 1,000 per invocation. The page budget would collapse to
// about eight pages.
//
// These variants do the same read-delete-insert against a whole page at once:
// three requests total regardless of how many work orders are involved.
//
// `workOrderIds` MUST be every work order on the page, not just the ones that
// came back with child rows. That is what clears lines someone deleted in
// MaintainX -- a work order whose last expenditure was removed shows up with
// an empty array, and if it were absent from the id list its stale row would
// survive forever.
// ---------------------------------------------------------------------------

/** Chunked plain INSERT (no upsert) for rows that were just deleted. */
async function insertInBatches(
  env: SupabaseWriteEnv,
  table: string,
  rows: unknown[],
  batchSize: number
): Promise<MxWriteResult> {
  if (rows.length === 0) return emptyResult();

  let written = 0;
  let requests = 0;
  let status = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const r = await rest(env, "POST", table, {}, {
      body: chunk,
      prefer: "return=minimal"
    });
    requests += 1;
    status = r.status;
    if (!r.ok) return { ok: false, written, requests, status, error: r.error };
    written += chunk.length;
  }

  return { ok: true, written, requests, status, error: null };
}

/** Replaces every part row for the given work orders. Parts carry no
 *  `first_seen_at`, so no snapshot read is needed -- two requests. */
export async function replaceMxWorkOrderPartsForPage(
  env: SupabaseWriteEnv,
  workOrderIds: number[],
  rows: MxWorkOrderPartRow[]
): Promise<MxWriteResult> {
  if (workOrderIds.length === 0) return emptyResult();

  const del = await rest(env, "DELETE", "mx_work_order_part", {
    work_order_id: `in.${inList(workOrderIds)}`
  }, { prefer: "return=minimal" });
  if (!del.ok) {
    return { ok: false, written: 0, requests: 1, status: del.status, error: del.error };
  }

  const ins = await insertInBatches(env, "mx_work_order_part", rows, MX_WORK_ORDER_BATCH);
  return { ...ins, requests: ins.requests + 1 };
}

/** Replaces every expenditure row for the given work orders, carrying
 *  `first_seen_at` forward per (work_order_id, dedupe_key). Three requests. */
export async function replaceMxWorkOrderExpendituresForPage(
  env: SupabaseWriteEnv,
  workOrderIds: number[],
  rows: MxWorkOrderExpenditureRow[]
): Promise<MxWriteResult> {
  if (workOrderIds.length === 0) return emptyResult();

  const snap = await selectChildrenForPage(
    env,
    "mx_work_order_expenditure",
    workOrderIds,
    "work_order_id,dedupe_key,first_seen_at"
  );
  if (!snap.ok) {
    return { ok: false, written: 0, requests: 1, status: snap.status, error: snap.error };
  }

  const seenAt = new Map<string, string>();
  for (const row of snap.rows) {
    const woId = row.work_order_id;
    const key = row.dedupe_key;
    const at = row.first_seen_at;
    if (typeof woId !== "number" || typeof key !== "string" || typeof at !== "string") continue;
    seenAt.set(`${woId}:${key}`, at);
  }

  const del = await rest(env, "DELETE", "mx_work_order_expenditure", {
    work_order_id: `in.${inList(workOrderIds)}`
  }, { prefer: "return=minimal" });
  if (!del.ok) {
    return { ok: false, written: 0, requests: 2, status: del.status, error: del.error };
  }

  const payload = rows.map((row) => {
    const carried = seenAt.get(`${row.work_order_id}:${row.dedupe_key}`);
    return carried ? { ...row, first_seen_at: carried } : row;
  });

  const ins = await insertInBatches(env, "mx_work_order_expenditure", payload, MX_WORK_ORDER_BATCH);
  return { ...ins, requests: ins.requests + 2 };
}

/** Replaces every time-item row for the given work orders, carrying
 *  `first_seen_at` forward on the synthesised content key. Three requests. */
export async function replaceMxWorkOrderTimeItemsForPage(
  env: SupabaseWriteEnv,
  workOrderIds: number[],
  rows: MxWorkOrderTimeItemRow[]
): Promise<MxWriteResult> {
  if (workOrderIds.length === 0) return emptyResult();

  const snap = await selectChildrenForPage(
    env,
    "mx_work_order_time_item",
    workOrderIds,
    "work_order_id,type,user_id,quantity_hours,duration_total_seconds,first_seen_at"
  );
  if (!snap.ok) {
    return { ok: false, written: 0, requests: 1, status: snap.status, error: snap.error };
  }

  const seenAt = new Map<string, string>();
  for (const row of snap.rows) {
    const woId = row.work_order_id;
    const at = row.first_seen_at;
    if (typeof woId !== "number" || typeof at !== "string") continue;
    const key = `${woId}:${timeItemKey({
      work_order_id: woId,
      ordinal: 0,
      type: typeof row.type === "string" ? row.type : null,
      user_id: typeof row.user_id === "number" ? row.user_id : null,
      quantity_hours: Number(row.quantity_hours ?? 0),
      duration_total_seconds: Number(row.duration_total_seconds ?? 0)
    })}`;
    if (!seenAt.has(key)) seenAt.set(key, at);
  }

  const del = await rest(env, "DELETE", "mx_work_order_time_item", {
    work_order_id: `in.${inList(workOrderIds)}`
  }, { prefer: "return=minimal" });
  if (!del.ok) {
    return { ok: false, written: 0, requests: 2, status: del.status, error: del.error };
  }

  const payload = rows.map((row) => {
    const carried = seenAt.get(`${row.work_order_id}:${timeItemKey(row)}`);
    return carried ? { ...row, first_seen_at: carried } : row;
  });

  const ins = await insertInBatches(env, "mx_work_order_time_item", payload, MX_COMMENT_BATCH);
  return { ...ins, requests: ins.requests + 2 };
}

/** Page-scoped sibling of `selectChildren`. Paginates nothing: the caller's
 *  page is at most 200 work orders and child fan-out is small. */
async function selectChildrenForPage(
  env: SupabaseWriteEnv,
  table: string,
  workOrderIds: number[],
  select: string
): Promise<{ ok: boolean; rows: Record<string, unknown>[]; status: number; error: string | null }> {
  const r = await rest(env, "GET", table, {
    select,
    work_order_id: `in.${inList(workOrderIds)}`
  });
  if (!r.ok) return { ok: false, rows: [], status: r.status, error: r.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body);
  } catch (err) {
    return {
      ok: false,
      rows: [],
      status: r.status,
      error: `unparseable body: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, rows: [], status: r.status, error: "expected an array" };
  }
  return {
    ok: true,
    rows: parsed.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null),
    status: r.status,
    error: null
  };
}

// ---------------------------------------------------------------------------
// 7. Comment pass support
//
// The comment pass (Phase 1 plan, section E) is not a cursor walk over a
// MaintainX collection the way the other passes are -- there is no `/comments`
// endpoint that spans work orders. It is a work-set drain: read a batch of work
// orders whose thread has moved, fetch each thread by id, write the comments,
// then stamp a watermark so the batch drops out of the work set.
//
// Both halves of that live here because both are PostgREST quirks rather than
// ingest logic.
// ---------------------------------------------------------------------------

export interface MxCommentBacklogRow {
  /** `mx_work_order.id` -- the id to hand to `fetchWorkOrderComments`. */
  id: number;
  /** Never null: the view filters `last_message_sent_at is not null`. This is
   *  the exact value to stamp back into `comments_synced_at` afterwards. */
  last_message_sent_at: string;
}

export interface MxCommentBacklogResult {
  ok: boolean;
  rows: MxCommentBacklogRow[];
  status: number;
  error: string | null;
}

/**
 * Reads the comment pass's work set.
 *
 * Reads the `mx_comment_backlog` VIEW, not `mx_work_order`. The defining
 * predicate compares `last_message_sent_at` against `comments_synced_at` --
 * column against column -- and PostgREST filters are column against literal,
 * so `last_message_sent_at=gt.comments_synced_at` asks Postgres to cast the
 * string "comments_synced_at" to timestamptz and comes back 400. The comparison
 * therefore has to live in the database:
 * supabase/maintainx-ingest-03-comment-backlog.sql.
 *
 * Ordered `last_message_sent_at desc` so a backlog too large for one tick
 * drains newest-first. If the pass never fully catches up, the threads it did
 * fetch are the ones somebody is currently talking in.
 */
export async function selectMxCommentBacklog(
  env: SupabaseWriteEnv,
  limit: number
): Promise<MxCommentBacklogResult> {
  const r = await rest(env, "GET", "mx_comment_backlog", {
    select: "id,last_message_sent_at",
    order: "last_message_sent_at.desc",
    limit: String(limit)
  });
  if (!r.ok) return { ok: false, rows: [], status: r.status, error: r.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body);
  } catch (err) {
    return {
      ok: false,
      rows: [],
      status: r.status,
      error: `unparseable body: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, rows: [], status: r.status, error: "expected an array" };
  }

  const rows: MxCommentBacklogRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row.id;
    const at = row.last_message_sent_at;
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    // A row that reached here without a watermark would be stamped with
    // `undefined` and requalify forever. The view makes it impossible; the
    // check makes it impossible to reintroduce by editing the view.
    if (typeof at !== "string" || at === "") continue;
    rows.push({ id, last_message_sent_at: at });
  }

  return { ok: true, rows, status: r.status, error: null };
}

export interface MxCommentStampRow {
  id: number;
  /** MUST be the `last_message_sent_at` this work order carried when its thread
   *  was fetched -- never `now()`. The backlog predicate is
   *  `last_message_sent_at > comments_synced_at`, so stamping a wall-clock time
   *  from our clock re-qualifies the row forever the moment MaintainX's clock
   *  runs ahead of ours. Stamping the row's own value cannot: it is the same
   *  clock on both sides of the comparison, so the row drops out immediately
   *  and returns only when a genuinely newer message arrives. */
  comments_synced_at: string;
}

/**
 * Advances `comments_synced_at` on work orders whose threads were just fetched,
 * and touches nothing else on those rows.
 *
 * A two-column upsert, deliberately. PostgREST builds its column list from the
 * FIRST object in the array and its `ON CONFLICT ... DO UPDATE SET` from that
 * same list, so a payload of `{id, comments_synced_at}` compiles to an update
 * of exactly those two columns and leaves title, status, costs and every other
 * column of the existing row alone. That is the mirror image of the rule in
 * maintainx-ingest-02-comments.sql -- `comments_synced_at` must never appear in
 * the WORK ORDER payload, and nothing but `comments_synced_at` may appear in
 * THIS one.
 *
 * The insert arm is unreachable in practice: every id here came out of
 * `mx_comment_backlog`, which is a view over `mx_work_order`. If it ever did
 * fire it would write a stub rather than fail -- every NOT NULL column on
 * `mx_work_order` except `id` carries a default, and Postgres forms the tuple
 * (applying defaults) before it detects the conflict.
 */
export function stampMxCommentsSynced(
  env: SupabaseWriteEnv,
  rows: MxCommentStampRow[]
): Promise<MxWriteResult> {
  return upsertInBatches(env, "mx_work_order", "id", rows, MX_WORK_ORDER_BATCH);
}
