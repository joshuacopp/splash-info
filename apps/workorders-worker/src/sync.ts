// Brief 71 — daily MaintainX user/team sync. Populates the
// `maintainx_users` and `maintainx_teams` Supabase cache tables that the
// `GET /workorders/api/list` handler joins against to resolve assignee
// names. Runs from the workorders-worker `scheduled` handler at 11:30
// UTC; can also be triggered on-demand via the
// `POST /workorders/api/sync-maintainx-users` endpoint.
//
// Fail-soft posture: partial failures don't abort the sync. Per-batch
// errors accumulate in the `errors[]` array on the SyncResult; the
// caller (scheduled handler / manual endpoint) logs the result.

import {
  upsertMaintainXTeams,
  upsertMaintainXUsers,
  type MaintainXTeamUpsertRow,
  type MaintainXUserUpsertRow
} from "@splash/db-supabase";

const PHASE_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 200;

export interface SyncEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  MAINTAINX_API_KEY?: string;
  MAINTAINX_BASE_URL: string;
}

export interface SyncPhaseStats {
  fetched: number;
  upserted: number;
  failed: number;
}

export interface SyncResult {
  users: SyncPhaseStats;
  teams: SyncPhaseStats;
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

interface RawMaintainXUser {
  id?: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  authType?: string | null;
}

interface RawMaintainXTeam {
  id?: number;
  name?: string | null;
}

interface PageEnvelope {
  data?: unknown;
  results?: unknown;
  users?: unknown;
  teams?: unknown;
  nextCursor?: unknown;
  nextPageUrl?: unknown;
}

/**
 * Pull every page from a MaintainX list endpoint, accumulating into
 * `out[]`. Pagination is cursor-based per MaintainX API — we look for
 * `nextCursor` (or `nextPageUrl`) on each response. The phase respects
 * a 30s wall-clock budget shared across all pages of a phase; on budget
 * exhaustion we stop early and surface a partial result.
 */
async function fetchAllPages<T>(
  env: SyncEnv,
  endpoint: "users" | "teams",
  abortSignal: AbortSignal
): Promise<{ items: T[]; errors: string[] }> {
  if (!env.MAINTAINX_API_KEY) {
    return { items: [], errors: [`MAINTAINX_API_KEY unbound; skipping ${endpoint} sync`] };
  }
  const items: T[] = [];
  const errors: string[] = [];
  const base = env.MAINTAINX_BASE_URL.replace(/\/$/, "");
  let cursor: string | null = null;
  let pageNumber = 0;
  const MAX_PAGES = 100; // 100 × 200 = 20k upper bound; protective cap

  while (pageNumber < MAX_PAGES) {
    if (abortSignal.aborted) {
      errors.push(`${endpoint} sync aborted at page ${pageNumber}`);
      break;
    }
    const url = new URL(`${base}/${endpoint}`);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.MAINTAINX_API_KEY}`,
          Accept: "application/json"
        },
        signal: abortSignal
      });
    } catch (err) {
      errors.push(
        `${endpoint} fetch threw on page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      break;
    }
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 1024);
      } catch {
        // ignore
      }
      errors.push(`${endpoint} page ${pageNumber} returned ${res.status}: ${body}`);
      break;
    }
    let parsed: PageEnvelope | unknown[] | null;
    try {
      parsed = (await res.json()) as PageEnvelope | unknown[];
    } catch (err) {
      errors.push(
        `${endpoint} page ${pageNumber} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
      );
      break;
    }

    let arr: unknown[] = [];
    let nextCursor: string | null = null;

    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === "object") {
      const env = parsed as PageEnvelope;
      if (Array.isArray(env.data)) arr = env.data;
      else if (Array.isArray(env.results)) arr = env.results;
      else if (endpoint === "users" && Array.isArray(env.users)) arr = env.users;
      else if (endpoint === "teams" && Array.isArray(env.teams)) arr = env.teams;

      if (typeof env.nextCursor === "string" && env.nextCursor) {
        nextCursor = env.nextCursor;
      } else if (typeof env.nextPageUrl === "string" && env.nextPageUrl) {
        // Some envelopes return a full URL rather than a raw cursor; pull
        // the `cursor` query param off it if present.
        try {
          const next = new URL(env.nextPageUrl);
          const candidate = next.searchParams.get("cursor");
          if (candidate) nextCursor = candidate;
        } catch {
          // ignore
        }
      }
    }

    for (const raw of arr) {
      if (raw && typeof raw === "object") items.push(raw as T);
    }
    pageNumber += 1;

    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { items, errors };
}

function projectUserRow(u: RawMaintainXUser, syncedAt: string): MaintainXUserUpsertRow | null {
  if (typeof u.id !== "number" || !Number.isFinite(u.id)) return null;
  const first = typeof u.firstName === "string" ? u.firstName : null;
  const last = typeof u.lastName === "string" ? u.lastName : null;
  const composed = [first, last].filter(Boolean).join(" ").trim();
  return {
    id: u.id,
    first_name: first,
    last_name: last,
    full_name: composed || null,
    email: typeof u.email === "string" ? u.email : null,
    phone_number: typeof u.phoneNumber === "string" ? u.phoneNumber : null,
    auth_type: typeof u.authType === "string" ? u.authType : null,
    last_synced_at: syncedAt
  };
}

function projectTeamRow(t: RawMaintainXTeam, syncedAt: string): MaintainXTeamUpsertRow | null {
  if (typeof t.id !== "number" || !Number.isFinite(t.id)) return null;
  return {
    id: t.id,
    name: typeof t.name === "string" ? t.name : null,
    last_synced_at: syncedAt
  };
}

export async function runMaintainXUserTeamSync(env: SyncEnv): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  // Users phase
  const usersController = new AbortController();
  const usersTimeout = setTimeout(() => usersController.abort(), PHASE_TIMEOUT_MS);
  let usersStats: SyncPhaseStats = { fetched: 0, upserted: 0, failed: 0 };
  try {
    const { items, errors: pageErrors } = await fetchAllPages<RawMaintainXUser>(
      env,
      "users",
      usersController.signal
    );
    errors.push(...pageErrors);
    usersStats.fetched = items.length;
    const rows: MaintainXUserUpsertRow[] = [];
    for (const u of items) {
      const row = projectUserRow(u, startedAt);
      if (row) rows.push(row);
      else usersStats.failed += 1;
    }
    if (rows.length > 0) {
      const upsert = await upsertMaintainXUsers(env, rows);
      usersStats.upserted = upsert.upserted;
      usersStats.failed += rows.length - upsert.upserted;
      errors.push(...upsert.errors);
    }
  } finally {
    clearTimeout(usersTimeout);
  }

  // Teams phase
  const teamsController = new AbortController();
  const teamsTimeout = setTimeout(() => teamsController.abort(), PHASE_TIMEOUT_MS);
  let teamsStats: SyncPhaseStats = { fetched: 0, upserted: 0, failed: 0 };
  try {
    const { items, errors: pageErrors } = await fetchAllPages<RawMaintainXTeam>(
      env,
      "teams",
      teamsController.signal
    );
    errors.push(...pageErrors);
    teamsStats.fetched = items.length;
    const rows: MaintainXTeamUpsertRow[] = [];
    for (const t of items) {
      const row = projectTeamRow(t, startedAt);
      if (row) rows.push(row);
      else teamsStats.failed += 1;
    }
    if (rows.length > 0) {
      const upsert = await upsertMaintainXTeams(env, rows);
      teamsStats.upserted = upsert.upserted;
      teamsStats.failed += rows.length - upsert.upserted;
      errors.push(...upsert.errors);
    }
  } finally {
    clearTimeout(teamsTimeout);
  }

  return {
    users: usersStats,
    teams: teamsStats,
    startedAt,
    finishedAt: new Date().toISOString(),
    errors
  };
}
