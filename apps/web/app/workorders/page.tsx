// Brief 70 + Brief 71 — Work Orders page. Top-level route (NOT under
// /admin/*). Middleware gate covers cookie-presence auth; the
// workorders-worker enforces the email-on-locations gate server-side.
//
// Server component. SSR fetches GET /workorders/api/list via the
// WORKORDERS_WORKER service binding (with URL fallback for `next dev`),
// then hands BOTH buckets (reactive + preventive) to a single client
// component that drives tab state + per-row expansion (Brief 71).

import {
  fetchWorkOrdersList,
  type WorkOrdersListResponse
} from "./_lib/worker-fetch";
import { WorkOrdersTabsClient } from "./_components/WorkOrdersTabsClient";

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

  return (
    <PageShell>
      <PageHeader subtitle="Open / In Progress / On Hold work orders across MaintainX, scoped to your assigned locations." />
      <Body data={result.data} />
    </PageShell>
  );
}

function Body({ data }: { data: WorkOrdersListResponse }) {
  return (
    <WorkOrdersTabsClient
      reactive={data.reactive.groups}
      preventive={data.preventive.groups}
      requests={data.requests.groups}
      fetchedAt={data.fetchedAt}
      truncated={data.truncated}
      requestsTruncated={data.requestsTruncated}
      accessibleLocationCount={data.accessibleLocationCount}
      mappedLocationCount={data.mappedLocationCount}
      accessibleLocations={data.accessibleLocations}
      currentUser={data.currentUser}
    />
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">{children}</section>
  );
}

function PageHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        MaintainX
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">Work Orders</h1>
      <p className="mt-2 text-sm text-splash-navy/70">{subtitle}</p>
    </div>
  );
}

function NoAccessCard() {
  return (
    <div className="rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-6">
      <h2 className="text-base font-semibold text-yellow-900">
        You aren&apos;t signed in.
      </h2>
      <p className="mt-2 text-sm text-yellow-900/90">
        Sign in to see work orders for your locations.
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
        Operator: bind{" "}
        <code className="rounded bg-yellow-100 px-1">MAINTAINX_API_KEY</code>{" "}
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
