// Brief 128 — Email queue admin viewer list page.
//
// Server-rendered list of recent rows in the Brief 127 `outbound_emails`
// queue, with filter dropdowns (status / source_worker / source_kind /
// date range) and offset pagination. Admin-tier gated; non-admins get a
// NoAccessCard. Worker re-validates on every API call as defense in depth.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import { DateRangePicker } from "../../_components/DateRangePicker";
import {
  listEmailQueueAdmin,
  type EmailQueueListItem,
  type EmailQueueStatus,
  type EmailQueueStatusFilter
} from "../forms/_lib/worker-fetch";
import NoAccessCard from "../forms/_components/NoAccessCard";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const DEFAULT_WINDOW_DAYS = 7;

const STATUS_OPTIONS: { value: EmailQueueStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "claimed", label: "Claimed" },
  { value: "sent", label: "Sent" },
  { value: "stuck", label: "Stuck" }
];

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  const n = new Date();
  return ymdUtc(
    new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
  );
}

function defaultFromYmd(): string {
  const n = new Date();
  const today = new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  );
  return ymdUtc(new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000));
}

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

function readIntParam(
  raw: string | string[] | undefined,
  fallback: number
): number {
  if (typeof raw !== "string") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isStatusFilter(v: string | undefined): v is EmailQueueStatusFilter {
  return (
    v === "pending" ||
    v === "claimed" ||
    v === "sent" ||
    v === "stuck" ||
    v === "all"
  );
}

export default async function EmailQueueListPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/email-queue" />;
  }
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  const statusRaw = readStringParam(sp.status);
  const status: EmailQueueStatusFilter = isStatusFilter(statusRaw)
    ? statusRaw
    : "all";
  const sourceWorker = readStringParam(sp.source_worker);
  const sourceKind = readStringParam(sp.source_kind);
  const from = readStringParam(sp.from);
  const to = readStringParam(sp.to);
  const offset = readIntParam(sp.offset, 0);

  let data: Awaited<ReturnType<typeof listEmailQueueAdmin>>;
  let fetchError: string | null = null;
  try {
    data = await listEmailQueueAdmin({
      status,
      source_worker: sourceWorker,
      source_kind: sourceKind,
      from,
      to,
      limit: PAGE_SIZE,
      offset
    });
  } catch (err) {
    data = null;
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (data === null && !fetchError) {
    return <NoAccessCard reason="forbidden" />;
  }

  const fromDefault = defaultFromYmd();
  const toDefault = todayYmd();

  // Build the source-worker / source-kind option lists from the current page;
  // these are best-effort hints for the operator, not authoritative facets.
  const workerOptions = uniqueSorted(
    (data?.items ?? []).map((i) => i.source_worker)
  );
  const kindOptions = uniqueSorted(
    (data?.items ?? []).map((i) => i.source_kind)
  );

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard/admin"
          className="text-splash-blue hover:underline"
        >
          ← Admin
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Infrastructure
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Email Queue</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Pending, sent, and stuck outbound emails from the{" "}
          <code>outbound_emails</code> queue. PA polls every 5 minutes;
          stuck rows can be retried or abandoned below.
        </p>
      </div>

      {/* Filter row — status / source filters as a plain GET form. Date
          range picker is rendered as its own sibling form (it pushes via
          router.push). Both update URL search params; either Apply
          re-renders the list. */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <form
          method="GET"
          className="flex flex-wrap items-end gap-3 rounded-splash-md border border-gray-light bg-white px-4 py-3"
        >
          <div>
            <label
              htmlFor="status"
              className="block text-xs font-semibold uppercase tracking-wide text-splash-navy/70"
            >
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={status}
              className="mt-1 rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm text-splash-navy"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="source_worker"
              className="block text-xs font-semibold uppercase tracking-wide text-splash-navy/70"
            >
              Source worker
            </label>
            <input
              id="source_worker"
              name="source_worker"
              list="email-queue-workers"
              defaultValue={sourceWorker ?? ""}
              placeholder="any"
              className="mt-1 w-40 rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm text-splash-navy"
            />
            <datalist id="email-queue-workers">
              {workerOptions.map((w) => (
                <option key={w} value={w} />
              ))}
            </datalist>
          </div>

          <div>
            <label
              htmlFor="source_kind"
              className="block text-xs font-semibold uppercase tracking-wide text-splash-navy/70"
            >
              Source kind
            </label>
            <input
              id="source_kind"
              name="source_kind"
              list="email-queue-kinds"
              defaultValue={sourceKind ?? ""}
              placeholder="any"
              className="mt-1 w-52 rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm text-splash-navy"
            />
            <datalist id="email-queue-kinds">
              {kindOptions.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </div>

          {/* Preserve the current date range across status/source filter
              submits — without these hidden inputs, the GET form would drop
              `from`/`to` whenever the operator hits Apply. */}
          {from && <input type="hidden" name="from" value={from} />}
          {to && <input type="hidden" name="to" value={to} />}

          <button
            type="submit"
            className="rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Apply
          </button>
        </form>

        <DateRangePicker
          defaultFromYmd={fromDefault}
          defaultToYmd={toDefault}
        />
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load email queue: {fetchError}
        </p>
      )}

      {data && (
        <>
          <p className="mb-3 text-sm text-splash-navy/70">
            {(data.total ?? data.items.length).toLocaleString()} row
            {(data.total ?? data.items.length) === 1 ? "" : "s"} between{" "}
            <code>{data.from}</code> and <code>{data.to}</code>.
            {data.limit_hit && " More rows available — page forward."}
          </p>

          <QueueTable items={data.items} />

          <Pagination
            offset={offset}
            pageSize={PAGE_SIZE}
            hasMore={data.limit_hit}
            status={status}
            sourceWorker={sourceWorker}
            sourceKind={sourceKind}
            from={from}
            to={to}
          />
        </>
      )}
    </section>
  );
}

function QueueTable({ items }: { items: EmailQueueListItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        No emails in this filter range.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Created</th>
            <th className="px-3 py-2 font-semibold">Source</th>
            <th className="px-3 py-2 font-semibold">Recipient</th>
            <th className="px-3 py-2 font-semibold">Subject</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Attempts</th>
            <th className="px-3 py-2 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} className="border-t border-gray-light align-top">
              <td className="px-3 py-2 text-splash-navy">
                <span title={formatAbsolute(r.created_at)}>
                  {formatRelative(r.created_at)}
                </span>
              </td>
              <td className="px-3 py-2 text-splash-navy">
                <div className="text-splash-navy/80">
                  <code className="text-xs">{r.source_worker}</code>
                </div>
                <div className="text-xs text-splash-navy/60">
                  <code>{r.source_kind}</code>
                </div>
              </td>
              <td className="px-3 py-2 text-splash-navy" title={r.recipient}>
                {truncate(r.recipient, 30)}
              </td>
              <td className="px-3 py-2 text-splash-navy" title={r.subject}>
                {truncate(r.subject, 60)}
              </td>
              <td className="px-3 py-2 text-splash-navy">
                <StatusPill status={r.status} />
              </td>
              <td className="px-3 py-2 text-splash-navy">
                {r.send_attempts}
              </td>
              <td className="px-3 py-2 text-splash-navy">
                <Link
                  href={`/admin/email-queue/${encodeURIComponent(r.id)}`}
                  className="text-splash-blue hover:underline"
                >
                  View →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: EmailQueueStatus }) {
  const cls =
    status === "sent"
      ? "bg-splash-success/15 text-splash-success"
      : status === "stuck"
        ? "bg-racecar-red/15 text-racecar-red"
        : status === "claimed"
          ? "bg-sudsy-blue/15 text-sudsy-blue"
          : "bg-gray-light text-splash-navy/70";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {status}
    </span>
  );
}

function Pagination({
  offset,
  pageSize,
  hasMore,
  status,
  sourceWorker,
  sourceKind,
  from,
  to
}: {
  offset: number;
  pageSize: number;
  hasMore: boolean;
  status: EmailQueueStatusFilter;
  sourceWorker: string | undefined;
  sourceKind: string | undefined;
  from: string | undefined;
  to: string | undefined;
}) {
  const buildHref = (nextOffset: number): string => {
    const qs = new URLSearchParams();
    if (status !== "all") qs.set("status", status);
    if (sourceWorker) qs.set("source_worker", sourceWorker);
    if (sourceKind) qs.set("source_kind", sourceKind);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (nextOffset > 0) qs.set("offset", String(nextOffset));
    const s = qs.toString();
    return s ? `?${s}` : "";
  };
  const prevOffset = Math.max(0, offset - pageSize);
  const nextOffset = offset + pageSize;
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <div>
        Showing rows {offset + 1}–{offset + pageSize}.
      </div>
      <div className="flex items-center gap-3">
        {offset > 0 ? (
          <Link
            href={`/admin/email-queue${buildHref(prevOffset)}`}
            className="rounded-splash-sm border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-gray-light"
          >
            ← Prev
          </Link>
        ) : (
          <span className="rounded-splash-sm border border-gray-light px-3 py-1.5 text-sm font-semibold text-splash-navy/40">
            ← Prev
          </span>
        )}
        {hasMore ? (
          <Link
            href={`/admin/email-queue${buildHref(nextOffset)}`}
            className="rounded-splash-sm border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-gray-light"
          >
            Next →
          </Link>
        ) : (
          <span className="rounded-splash-sm border border-gray-light px-3 py-1.5 text-sm font-semibold text-splash-navy/40">
            Next →
          </span>
        )}
      </div>
    </div>
  );
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatAbsolute(iso);
}
