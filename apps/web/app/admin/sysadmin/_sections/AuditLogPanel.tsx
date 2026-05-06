// AuditLogPanel — surfaces sysadmin_audit_log inline on /admin/sysadmin.
// Brief 30. Replaces the page-banner blurb that used to *mention* the
// audit table without ever showing its content.
//
// Shape: filter row above a compact table. Filters live in URL search
// params (audit_actor / audit_action / audit_table / audit_user_id /
// audit_location_code / audit_offset). The form is GET-method so submit
// updates the URL; the page is server-rendered and re-fetches the log
// on every render.
//
// Data: GET /sysadmin/api/audit-log via the existing sysadminGetJson
// helper (service-binding + URL fallback). Empty / error states are
// scoped to the panel — they don't crash the rest of the page.
//
// Relative time: server-rendered for v1 (single helper, no client
// island). The "When" cell carries a title attr with the absolute
// ISO-8601 timestamp.

import Link from "next/link";
import { sysadminGetJson } from "../_lib/worker-fetch";
import { UserPicker } from "../_components/UserPicker";

interface AuditLogRow {
  id: string | number;
  created_at: string;
  actor_id: string | null;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  notes: string | null;
}

interface AuditLogResponse {
  rows: AuditLogRow[];
  total_estimate: number | null;
  next_offset: number | null;
}

const ALLOWED_ACTIONS = [
  "create_user",
  "set_role_super_admin",
  "set_role_location_admin",
  "clear_role",
  "grant_tool",
  "grant_tool_noop",
  "revoke_tool",
  "revoke_tool_noop",
  "reset_password",
  "create_location",
  "update_package",
  "update_location"
] as const;

const ALLOWED_TARGET_TYPES = [
  "user_permissions",
  "user_tool_access",
  "auth.users",
  "pricing_simple",
  "locations"
] as const;

interface AuditLogPanelProps {
  searchParams: Record<string, string | string[] | undefined>;
}

function readStr(
  sp: Record<string, string | string[] | undefined>,
  key: string
): string {
  const v = sp[key];
  return typeof v === "string" ? v : "";
}

function buildQueryString(filters: {
  actor: string;
  action: string;
  table: string;
  userId: string;
  locationCode: string;
  offset: number;
  limit: number;
}): string {
  const usp = new URLSearchParams();
  if (filters.actor.length > 0) usp.set("actor", filters.actor);
  if (filters.action.length > 0) usp.set("action", filters.action);
  if (filters.table.length > 0) usp.set("table", filters.table);
  if (filters.userId.length > 0) usp.set("user_id", filters.userId);
  if (filters.locationCode.length > 0) {
    usp.set("location_code", filters.locationCode);
  }
  if (filters.offset > 0) usp.set("offset", String(filters.offset));
  usp.set("limit", String(filters.limit));
  return usp.toString();
}

function modeHref(
  sp: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | undefined>
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v.length > 0) usp.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) usp.delete(k);
    else usp.set(k, v);
  }
  const s = usp.toString();
  return s.length > 0 ? `/admin/sysadmin?${s}` : "/admin/sysadmin";
}

const LIMIT = 50;

export async function AuditLogPanel({ searchParams }: AuditLogPanelProps) {
  const actor = readStr(searchParams, "audit_actor").trim();
  const action = readStr(searchParams, "audit_action").trim();
  const table = readStr(searchParams, "audit_table").trim();
  const userId = readStr(searchParams, "audit_user_id").trim();
  const locationCode = readStr(searchParams, "audit_location_code").trim();
  const offsetRaw = readStr(searchParams, "audit_offset").trim();
  const offsetParsed = offsetRaw.length > 0 ? Number(offsetRaw) : 0;
  const offset =
    Number.isInteger(offsetParsed) && offsetParsed >= 0 ? offsetParsed : 0;

  const qs = buildQueryString({
    actor,
    action,
    table,
    userId,
    locationCode,
    offset,
    limit: LIMIT
  });

  let response: AuditLogResponse | null = null;
  let errorMessage: string | null = null;
  try {
    response = await sysadminGetJson<AuditLogResponse>(
      `/sysadmin/api/audit-log?${qs}`
    );
    if (response === null) {
      errorMessage = "Sign in required to view the audit log.";
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown error";
  }

  const rows = response?.rows ?? [];
  const totalEstimate = response?.total_estimate ?? null;
  const nextOffset = response?.next_offset ?? null;

  const hasFilters =
    actor.length > 0 ||
    action.length > 0 ||
    table.length > 0 ||
    userId.length > 0 ||
    locationCode.length > 0;

  const showingFrom = rows.length > 0 ? offset + 1 : 0;
  const showingTo = offset + rows.length;

  return (
    <section
      id="audit-log"
      className="mt-9 rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-splash-navy">Activity log</h2>
        <p className="text-xs text-splash-navy/60">
          Newest first · super-admin observation only · reads aren&rsquo;t
          logged
        </p>
      </div>

      <AuditFilters
        searchParams={searchParams}
        actor={actor}
        action={action}
        table={table}
        userId={userId}
        locationCode={locationCode}
        hasFilters={hasFilters}
      />

      {errorMessage ? (
        <div
          role="alert"
          className="mt-4 rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny"
        >
          Could not load audit log: {errorMessage}
        </div>
      ) : null}

      {!errorMessage && rows.length === 0 ? (
        <p className="mt-5 text-sm italic text-splash-navy/60">
          No audit entries match these filters.
        </p>
      ) : null}

      {!errorMessage && rows.length > 0 ? (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-light text-left">
                  <th className="py-2 pr-3 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    When
                  </th>
                  <th className="py-2 pr-3 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Actor
                  </th>
                  <th className="py-2 pr-3 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Action
                  </th>
                  <th className="py-2 pr-3 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Target
                  </th>
                  <th className="py-2 pr-1 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Diff
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <AuditRow key={String(row.id)} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-splash-navy/70">
            <div>
              Showing {showingFrom}&ndash;{showingTo}
              {totalEstimate !== null
                ? ` of ~${totalEstimate.toLocaleString()}`
                : ""}
            </div>
            {nextOffset !== null ? (
              <Link
                href={modeHref(searchParams, {
                  audit_offset: String(nextOffset)
                })}
                className="font-semibold text-splash-blue hover:text-splash-blue-dark"
              >
                Load more &rarr;
              </Link>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/* ============================================================
 * Filter row
 * ============================================================ */

function AuditFilters({
  searchParams,
  actor,
  action,
  table,
  userId,
  locationCode,
  hasFilters
}: {
  searchParams: Record<string, string | string[] | undefined>;
  actor: string;
  action: string;
  table: string;
  userId: string;
  locationCode: string;
  hasFilters: boolean;
}) {
  const mode = readStr(searchParams, "mode");

  return (
    <form
      method="get"
      action="/admin/sysadmin"
      className="grid grid-cols-1 gap-3 rounded-splash-sm border border-gray-light bg-sudsy-blue-soft/30 p-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {/* Preserve the active mode through the GET submit. */}
      {mode.length > 0 ? (
        <input type="hidden" name="mode" value={mode} />
      ) : null}
      {/* Filter changes reset offset to 0. */}
      <input type="hidden" name="audit_offset" value="0" />

      <div>
        <label
          htmlFor="audit-actor"
          className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-wider text-splash-navy/70"
        >
          Actor email
        </label>
        <input
          id="audit-actor"
          name="audit_actor"
          type="text"
          defaultValue={actor}
          placeholder="alice@splash…"
          autoComplete="off"
          className="w-full rounded-splash-sm border border-gray-light bg-white px-2.5 py-1.5 text-sm text-splash-navy shadow-inner focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        />
      </div>

      <div>
        <label
          htmlFor="audit-action"
          className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-wider text-splash-navy/70"
        >
          Action
        </label>
        <select
          id="audit-action"
          name="audit_action"
          defaultValue={action}
          className="w-full rounded-splash-sm border border-gray-light bg-white px-2.5 py-1.5 text-sm text-splash-navy shadow-inner focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        >
          <option value="">(any)</option>
          {ALLOWED_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="audit-table"
          className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-wider text-splash-navy/70"
        >
          Table
        </label>
        <select
          id="audit-table"
          name="audit_table"
          defaultValue={table}
          className="w-full rounded-splash-sm border border-gray-light bg-white px-2.5 py-1.5 text-sm text-splash-navy shadow-inner focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        >
          <option value="">(any)</option>
          {ALLOWED_TARGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="audit-user-id"
          className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-wider text-splash-navy/70"
        >
          User
        </label>
        <UserPicker
          name="audit_user_id"
          inputId="audit-user-id"
          defaultValue={userId.length > 0 ? userId : undefined}
          defaultLabel={
            userId.length > 0 ? "(filtering — clear to change)" : undefined
          }
          placeholder="Filter by user…"
        />
      </div>

      <div>
        <label
          htmlFor="audit-location-code"
          className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-wider text-splash-navy/70"
        >
          Location code
        </label>
        <input
          id="audit-location-code"
          name="audit_location_code"
          type="text"
          defaultValue={locationCode}
          placeholder="binghamton"
          autoComplete="off"
          pattern="[a-z0-9_]*"
          className="w-full rounded-splash-sm border border-gray-light bg-white px-2.5 py-1.5 font-mono text-sm text-splash-navy shadow-inner focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        />
      </div>

      <div className="flex items-end gap-3">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
        >
          Apply filters
        </button>
        {hasFilters ? (
          <Link
            href={modeHref(searchParams, {
              audit_actor: undefined,
              audit_action: undefined,
              audit_table: undefined,
              audit_user_id: undefined,
              audit_location_code: undefined,
              audit_offset: undefined
            })}
            className="text-xs font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Reset
          </Link>
        ) : null}
      </div>
    </form>
  );
}

/* ============================================================
 * Audit row
 * ============================================================ */

function AuditRow({ row }: { row: AuditLogRow }) {
  const isSystem = row.actor_email === "system";
  const isNoop = row.action.endsWith("_noop");
  const before = row.before ?? null;
  const after = row.after ?? null;

  return (
    <tr className="border-b border-gray-light/60 align-top">
      <td className="py-2 pr-3 text-xs text-splash-navy/80">
        <span title={row.created_at}>{relativeTime(row.created_at)}</span>
      </td>
      <td className="py-2 pr-3 text-xs">
        {isSystem ? (
          <span className="italic text-splash-navy/70">system</span>
        ) : (
          <span className="text-splash-navy">{row.actor_email}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs">
        <span className="font-mono text-splash-navy">{row.action}</span>
        {isNoop ? (
          <span className="ml-1 rounded-sm bg-gray-light/60 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-splash-navy/60">
            no-op
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3 text-xs">
        <TargetCell row={row} />
      </td>
      <td className="py-2 pr-1">
        <DiffCell before={before} after={after} notes={row.notes} />
      </td>
    </tr>
  );
}

function TargetCell({ row }: { row: AuditLogRow }) {
  const targetId = row.target_id ?? "";
  // UUIDs are 36 chars; truncate after 8 with title attr for the full id.
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    targetId
  );
  return (
    <span className="font-mono text-splash-navy">
      <span className="text-splash-navy/60">{row.target_type}</span>
      {targetId.length > 0 ? (
        <>
          <span className="text-splash-navy/40">/</span>
          {isUuid ? (
            <span title={targetId}>{targetId.slice(0, 8)}…</span>
          ) : (
            <span>{targetId}</span>
          )}
        </>
      ) : null}
    </span>
  );
}

function DiffCell({
  before,
  after,
  notes
}: {
  before: unknown;
  after: unknown;
  notes: string | null;
}) {
  const onlyAfter = before === null && after !== null;
  const onlyBefore = after === null && before !== null;
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-semibold text-splash-blue hover:text-splash-blue-dark">
        View
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        {!onlyAfter ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-splash-navy/60">
              Before
            </div>
            <pre className="overflow-x-auto rounded-sm bg-gray-light/40 p-2 text-[11px] leading-snug text-splash-navy">
              {jsonOrDash(before)}
            </pre>
          </div>
        ) : null}
        {!onlyBefore ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-splash-navy/60">
              After
            </div>
            <pre className="overflow-x-auto rounded-sm bg-gray-light/40 p-2 text-[11px] leading-snug text-splash-navy">
              {jsonOrDash(after)}
            </pre>
          </div>
        ) : null}
      </div>
      {notes ? (
        <p className="mt-2 text-[11px] italic text-splash-navy/70">
          {notes}
        </p>
      ) : null}
    </details>
  );
}

function jsonOrDash(v: unknown): string {
  if (v === null || v === undefined) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Server-rendered relative time. Sufficient for v1 — the page only updates
 * on refresh, so the rendered "3m ago" is correct as of request time. The
 * absolute ISO timestamp lives on the title attr for hover.
 */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (deltaSec < 45) return "just now";
  if (deltaSec < 60 * 90) {
    const m = Math.round(deltaSec / 60);
    return `${m}m ago`;
  }
  if (deltaSec < 60 * 60 * 24) {
    const h = Math.round(deltaSec / 3600);
    return `${h}h ago`;
  }
  const days = Math.round(deltaSec / 86400);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
