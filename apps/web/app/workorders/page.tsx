// Brief 70 — Work Orders page. Top-level route (NOT under /admin/*) per
// operator's 2026-05-07 decision; middleware gate covers cookie-presence
// auth. dc_role permission is enforced server-side by workorders-worker.
//
// Server component. SSR fetches GET /workorders/api/list via the
// WORKORDERS_WORKER service binding (with URL fallback for `next dev`),
// renders the grouped + sorted result. No client islands required for v1
// (timestamps render with a simple server-side relative-time helper).

import {
  fetchWorkOrdersList,
  type UnmatchedWorkOrder,
  type WorkOrderItem,
  type WorkOrdersListResponse
} from "./_lib/worker-fetch";
import { PriorityPill } from "./_components/PriorityPill";
import { StatusPill } from "./_components/StatusPill";
import { EmptyState } from "./_components/EmptyState";

export const dynamic = "force-dynamic";

export default async function WorkOrdersPage() {
  const result = await fetchWorkOrdersList();

  if (result.kind === "denied") {
    return (
      <PageShell>
        <PageHeader subtitle="Open MaintainX work orders for your locations." />
        <NoAccessCard />
      </PageShell>
    );
  }
  if (result.kind === "not_configured") {
    return (
      <PageShell>
        <PageHeader subtitle="Open MaintainX work orders for your locations." />
        <NotConfiguredCard />
      </PageShell>
    );
  }
  if (result.kind === "error") {
    return (
      <PageShell>
        <PageHeader subtitle="Open MaintainX work orders for your locations." />
        <ErrorCard message={result.message} status={result.status} />
      </PageShell>
    );
  }

  const data = result.data;
  return (
    <PageShell>
      <PageHeader
        subtitle="Open / In Progress / On Hold work orders across MaintainX, scoped to your assigned locations."
        fetchedAt={data.fetchedAt}
      />

      {data.missingMaintainxIds.length > 0 ? (
        <MissingMappingWarning codes={data.missingMaintainxIds} />
      ) : null}

      {data.truncated ? <TruncatedNotice /> : null}

      {data.groups.length === 0 && data.unmatchedWorkOrders.length === 0 ? (
        <EmptyState />
      ) : null}

      {data.groups.map((group) => (
        <GroupSection key={group.maintainx_id} group={group} />
      ))}

      {data.scope === "global" && data.unmatchedWorkOrders.length > 0 ? (
        <UnmatchedSection unmatched={data.unmatchedWorkOrders} />
      ) : null}
    </PageShell>
  );
}

/* ============================================================
 * Shell + header
 * ============================================================ */

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">{children}</section>
  );
}

function PageHeader({
  subtitle,
  fetchedAt
}: {
  subtitle: string;
  fetchedAt?: string;
}) {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        MaintainX
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">Work Orders</h1>
      <p className="mt-2 text-sm text-splash-navy/70">
        {subtitle}
        {fetchedAt ? (
          <>
            {" "}
            <span className="text-splash-navy/50">
              · As of {formatRelativeTime(fetchedAt)}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

/* ============================================================
 * Status / error cards
 * ============================================================ */

function NoAccessCard() {
  return (
    <div className="rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-6">
      <h2 className="text-base font-semibold text-yellow-900">
        Work Orders access is gated on a damage-claim role.
      </h2>
      <p className="mt-2 text-sm text-yellow-900/90">
        Ask a super_admin to grant you a DC role through the sysadmin
        Set DC Role tool.
      </p>
    </div>
  );
}

function NotConfiguredCard() {
  return (
    <div className="rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-6">
      <h2 className="text-base font-semibold text-yellow-900">
        MaintainX integration not configured.
      </h2>
      <p className="mt-2 text-sm text-yellow-900/90">
        Operator: bind <code className="rounded bg-yellow-100 px-1">MAINTAINX_API_KEY</code>{" "}
        on splash-workorders via{" "}
        <code className="rounded bg-yellow-100 px-1">wrangler secret put</code>.
      </p>
    </div>
  );
}

function ErrorCard({ message, status }: { message: string; status: number }) {
  return (
    <div className="rounded-splash-lg border border-splash-deny/50 bg-splash-deny/10 px-6 py-6">
      <h2 className="text-base font-semibold text-splash-deny">
        Couldn&apos;t load work orders
      </h2>
      <p className="mt-2 text-sm text-splash-navy/80">
        {message} (status {status}). Try reloading; if the problem persists,
        log into MaintainX directly.
      </p>
    </div>
  );
}

function MissingMappingWarning({ codes }: { codes: string[] }) {
  return (
    <div className="mb-5 rounded-splash-lg border border-yellow-300 bg-yellow-50 px-5 py-3">
      <p className="text-sm font-semibold text-yellow-900">
        {codes.length} of your location{codes.length === 1 ? "" : "s"} {codes.length === 1 ? "doesn't" : "don't"} have a MaintainX ID mapped.
      </p>
      <p className="mt-1 text-xs text-yellow-900/80">
        Work orders for {codes.length === 1 ? "this location" : "these locations"} won&apos;t appear here.
        Ask a super_admin to update <code>locations.maintainx_id</code>.
      </p>
      <details className="mt-2 text-xs text-yellow-900/80">
        <summary className="cursor-pointer">Show locations</summary>
        <ul className="mt-1 list-disc pl-5">
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function TruncatedNotice() {
  return (
    <div className="mb-5 rounded-splash-lg border border-sudsy-blue/40 bg-sudsy-blue/10 px-5 py-3 text-sm text-splash-navy/80">
      Showing the first 200 work orders. For the full list, log into MaintainX directly.
    </div>
  );
}

/* ============================================================
 * Group section + table rows
 * ============================================================ */

function GroupSection({ group }: { group: WorkOrdersListResponse["groups"][number] }) {
  const headerLabel = group.location_pretty ?? group.location_code;
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-lg font-bold text-splash-navy">
        {headerLabel}{" "}
        <span className="text-sm font-normal text-splash-navy/60">
          · {group.work_orders.length} open
        </span>
      </h2>
      <div className="overflow-x-auto rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-light/40 text-left text-[11px] font-semibold uppercase tracking-wide text-splash-navy/70">
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Assignees</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2 text-right">MaintainX</th>
            </tr>
          </thead>
          <tbody>
            {group.work_orders.map((wo) => (
              <WorkOrderRow key={wo.id} wo={wo} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkOrderRow({ wo }: { wo: WorkOrderItem }) {
  return (
    <tr className="border-t border-gray-light/60 align-top">
      <td className="px-3 py-2.5 whitespace-nowrap">
        <PriorityPill priority={wo.priority} />
      </td>
      <td className="px-3 py-2.5">
        <div className="font-medium text-splash-navy">{wo.title || "(no title)"}</div>
        <div className="mt-0.5 text-xs text-splash-navy/60">
          {wo.sequentialId != null ? <span>#{wo.sequentialId}</span> : null}
          {wo.description ? (
            <>
              {wo.sequentialId != null ? <span> · </span> : null}
              <span>{truncateOneLine(wo.description, 120)}</span>
            </>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <StatusPill status={wo.status} />
      </td>
      <td className="px-3 py-2.5 text-sm text-splash-navy">
        {wo.assignees.length === 0
          ? "—"
          : wo.assignees.map((a) => a.name).join(", ")}
      </td>
      <td
        className="px-3 py-2.5 whitespace-nowrap text-xs text-splash-navy/70"
        title={wo.updatedAt ?? undefined}
      >
        {wo.updatedAt ? formatRelativeTime(wo.updatedAt) : "—"}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-right">
        <a
          href={`https://app.getmaintainx.com/workorders/${wo.id}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-splash-blue hover:underline"
        >
          Open ↗
        </a>
      </td>
    </tr>
  );
}

/* ============================================================
 * Unmatched section (global scope only)
 * ============================================================ */

function UnmatchedSection({ unmatched }: { unmatched: UnmatchedWorkOrder[] }) {
  return (
    <section className="mt-9">
      <h2 className="mb-2 text-lg font-bold text-splash-navy/80">
        Unmapped MaintainX locations
      </h2>
      <p className="mb-2 text-sm text-splash-navy/60">
        These work orders are in MaintainX but their <code>locationId</code> doesn&apos;t
        map to a Splash <code>locations</code> row. Map via the sysadmin
        Update Location editor.
      </p>
      <div className="overflow-x-auto rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-light/40 text-left text-[11px] font-semibold uppercase tracking-wide text-splash-navy/70">
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">MaintainX Location</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2 text-right">MaintainX</th>
            </tr>
          </thead>
          <tbody>
            {unmatched.map((wo) => (
              <tr key={wo.id} className="border-t border-gray-light/60 align-top">
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <PriorityPill priority={wo.priority} />
                </td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-splash-navy">
                    {wo.title || "(no title)"}
                  </div>
                  {wo.sequentialId != null ? (
                    <div className="mt-0.5 text-xs text-splash-navy/60">
                      #{wo.sequentialId}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-sm text-splash-navy/80">
                  {wo.maintainxLocationName ?? "—"}
                  {wo.maintainxLocationId != null ? (
                    <span className="ml-1 text-xs text-splash-navy/50">
                      (id {wo.maintainxLocationId})
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <StatusPill status={wo.status} />
                </td>
                <td
                  className="px-3 py-2.5 whitespace-nowrap text-xs text-splash-navy/70"
                  title={wo.updatedAt ?? undefined}
                >
                  {wo.updatedAt ? formatRelativeTime(wo.updatedAt) : "—"}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-right">
                  <a
                    href={`https://app.getmaintainx.com/workorders/${wo.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-semibold text-splash-blue hover:underline"
                  >
                    Open ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** Server-rendered relative-time formatter. "2 hours ago" / "yesterday" /
 *  fallback to a short absolute date for >7 days. */
function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffMs = now - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  // >7 days — short absolute (Mar 5)
  const d = new Date(then);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
