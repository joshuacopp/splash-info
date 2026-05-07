// Brief 71 — Supabase read + upsert helpers for the `maintainx_users` and
// `maintainx_teams` cache tables.
//
// The cache is populated by the daily MaintainX user/team sync running on
// the workorders-worker `scheduled` handler (and the manual-trigger
// `POST /workorders/api/sync-maintainx-users` endpoint). The
// `GET /workorders/api/list` handler joins the cache against the work-order
// `assignees[].id` field to resolve names; missing IDs render as
// `User #${id}` / `Team #${id}` so the page degrades gracefully when a
// MaintainX user is created between syncs.

const HEADERS = (env: { SUPABASE_SERVICE_KEY: string }) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

export interface MaintainXUserRow {
  id: number;
  full_name: string | null;
  email: string | null;
}

export interface MaintainXTeamRow {
  id: number;
  name: string | null;
}

/**
 * Bulk read MaintainX user names by ID for the WO read-path join.
 * Returns a Map for O(1) lookup keyed by the upstream MaintainX user ID.
 *
 * Empty input → empty Map. Fail-soft: any throw / non-2xx → empty Map
 * (caller falls back to `User #${id}`).
 */
export async function getMaintainXUsersByIds(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  ids: number[]
): Promise<Map<number, MaintainXUserRow>> {
  const distinct = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (distinct.length === 0) return new Map();

  const url = new URL("/rest/v1/maintainx_users", env.SUPABASE_URL);
  url.searchParams.set("id", `in.(${distinct.map(String).join(",")})`);
  url.searchParams.set("select", "id,full_name,email");
  url.searchParams.set("limit", "500");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: HEADERS(env) });
  } catch (err) {
    console.error("getMaintainXUsersByIds: fetch threw", err);
    return new Map();
  }
  if (!response.ok) {
    console.error("getMaintainXUsersByIds: returned", response.status);
    return new Map();
  }
  const rows = (await response.json().catch(() => [])) as MaintainXUserRow[];
  const out = new Map<number, MaintainXUserRow>();
  for (const r of rows) {
    if (typeof r?.id !== "number" || !Number.isFinite(r.id)) continue;
    out.set(r.id, {
      id: r.id,
      full_name: typeof r.full_name === "string" ? r.full_name : null,
      email: typeof r.email === "string" ? r.email : null
    });
  }
  return out;
}

/** Bulk read MaintainX team names by ID. Same fail-soft posture as users. */
export async function getMaintainXTeamsByIds(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  ids: number[]
): Promise<Map<number, MaintainXTeamRow>> {
  const distinct = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (distinct.length === 0) return new Map();

  const url = new URL("/rest/v1/maintainx_teams", env.SUPABASE_URL);
  url.searchParams.set("id", `in.(${distinct.map(String).join(",")})`);
  url.searchParams.set("select", "id,name");
  url.searchParams.set("limit", "500");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: HEADERS(env) });
  } catch (err) {
    console.error("getMaintainXTeamsByIds: fetch threw", err);
    return new Map();
  }
  if (!response.ok) {
    console.error("getMaintainXTeamsByIds: returned", response.status);
    return new Map();
  }
  const rows = (await response.json().catch(() => [])) as MaintainXTeamRow[];
  const out = new Map<number, MaintainXTeamRow>();
  for (const r of rows) {
    if (typeof r?.id !== "number" || !Number.isFinite(r.id)) continue;
    out.set(r.id, {
      id: r.id,
      name: typeof r.name === "string" ? r.name : null
    });
  }
  return out;
}

export interface MaintainXUserUpsertRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone_number: string | null;
  auth_type: string | null;
  last_synced_at: string;
}

export interface MaintainXTeamUpsertRow {
  id: number;
  name: string | null;
  last_synced_at: string;
}

const UPSERT_BATCH_SIZE = 500;

async function upsertBatch(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  table: "maintainx_users" | "maintainx_teams",
  rows: unknown[]
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  url.searchParams.set("on_conflict", "id");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...HEADERS(env),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(rows)
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }
  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 1024);
    } catch {
      // ignore
    }
    return {
      ok: false,
      status: response.status,
      error: `${response.status}: ${body}`
    };
  }
  return { ok: true, status: response.status, error: null };
}

export interface UpsertResult {
  upserted: number;
  errors: string[];
}

export async function upsertMaintainXUsers(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  rows: MaintainXUserUpsertRow[]
): Promise<UpsertResult> {
  return upsertInBatches(env, "maintainx_users", rows);
}

export async function upsertMaintainXTeams(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  rows: MaintainXTeamUpsertRow[]
): Promise<UpsertResult> {
  return upsertInBatches(env, "maintainx_teams", rows);
}

async function upsertInBatches(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  table: "maintainx_users" | "maintainx_teams",
  rows: unknown[]
): Promise<UpsertResult> {
  if (rows.length === 0) return { upserted: 0, errors: [] };

  let upserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const slice = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const result = await upsertBatch(env, table, slice);
    if (result.ok) {
      upserted += slice.length;
    } else {
      errors.push(
        `${table} batch ${i / UPSERT_BATCH_SIZE} (${slice.length} rows) failed: ${result.error ?? "unknown error"}`
      );
    }
  }
  return { upserted, errors };
}
