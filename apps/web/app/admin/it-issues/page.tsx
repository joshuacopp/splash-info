// IT Issue Tracker -- list (/admin/it-issues).
//
// One shared log in place of a spreadsheet per site. The worker scopes rows:
// a site sees its own issues, a Regional Manager / Director their region,
// admin tier everything.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { canUseItIssues } from "./_lib/access";
import { BetaGate } from "./_components/BetaGate";
import { listIssues } from "./_lib/worker-fetch";
import {
  PRIORITY_PILL,
  STATUS_PILL,
  daysSince,
  deviceLabel,
  formatEt,
  priorityLabel,
  statusLabel,
  type Issue
} from "./_lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function param(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function ItIssuesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/it-issues" />;
  if (!canUseItIssues(session)) return <BetaGate />;

  const status = ["open", "resolved", "all"].includes(param(sp.status)) ? param(sp.status) : "open";
  const qs = new URLSearchParams({ status });
  if (param(sp.location_id)) qs.set("location_id", param(sp.location_id));
  if (param(sp.device)) qs.set("device", param(sp.device));

  const data = await listIssues(qs);
  const issues = [...(data?.issues ?? [])];
  if (status === "open") {
    issues.sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        Date.parse(a.first_reported_at) - Date.parse(b.first_reported_at)
    );
  }
  const noSites = data && data.sites.length === 0;

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/dashboard/operations" className="text-splash-blue hover:underline">
          ← Operations
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">Operations</p>
          <h1 className="text-2xl font-bold text-splash-navy">IT Issues</h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            One record per problem. If it happens again, open it and log another occurrence instead of starting a new
            one.
          </p>
        </div>
        {!noSites && (
          <Link
            href="/admin/it-issues/new"
            className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy"
          >
            + Report an IT issue
          </Link>
        )}
      </div>

      {!data && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Could not load IT issues. Try again in a moment.
        </p>
      )}

      {noSites && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center text-splash-navy/70">
          Your login isn&apos;t linked to any site, so there are no IT issues to show. Ask a super admin to add your
          email to your site.
        </div>
      )}

      {data && !noSites && (
        <>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="font-semibold text-splash-navy/70">Show</span>
              <select name="status" defaultValue={status} className="rounded-splash-sm border border-gray-light bg-white px-2 py-1.5">
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="all">All</option>
              </select>
            </label>
            {data.sites.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="font-semibold text-splash-navy/70">Site</span>
                <select
                  name="location_id"
                  defaultValue={param(sp.location_id)}
                  className="rounded-splash-sm border border-gray-light bg-white px-2 py-1.5"
                >
                  <option value="">All my sites</option>
                  {data.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="font-semibold text-splash-navy/70">Device</span>
              <select name="device" defaultValue={param(sp.device)} className="rounded-splash-sm border border-gray-light bg-white px-2 py-1.5">
                <option value="">Any device</option>
                {data.devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded-splash-sm border border-splash-blue px-3 py-1.5 font-semibold text-splash-blue hover:bg-splash-blue hover:text-white">
              Filter
            </button>
          </form>

          {issues.length === 0 ? (
            <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
              {status === "open" ? "No open IT issues." : "Nothing to show for this filter."}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-light/50 text-xs uppercase tracking-wide text-splash-navy/60">
                  <tr>
                    <th className="px-3 py-2">Ref</th>
                    <th className="px-3 py-2">Site</th>
                    <th className="px-3 py-2">Device / problem</th>
                    <th className="px-3 py-2">Priority</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Times</th>
                    <th className="px-3 py-2">First reported</th>
                    <th className="px-3 py-2">Tickets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-light">
                  {issues.map((i) => (
                    <IssueRow key={i.id} issue={i} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function IssueRow({ issue: i }: { issue: Issue }) {
  const age = daysSince(i.first_reported_at);
  return (
    <tr className="align-top hover:bg-gray-light/30">
      <td className="px-3 py-2 font-semibold">
        <Link href={`/admin/it-issues/${i.id}`} className="text-splash-blue hover:underline">
          IT-{i.ref_no}
        </Link>
      </td>
      <td className="whitespace-nowrap px-3 py-2">{i.site_name}</td>
      <td className="px-3 py-2">
        <div className="font-semibold text-splash-navy">{deviceLabel(i)}</div>
        <div className="text-splash-navy/80">{i.problem}</div>
      </td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PRIORITY_PILL[i.priority]}`}>
          {priorityLabel(i.priority)}
        </span>
      </td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_PILL[i.status]}`}>
          {statusLabel(i.status)}
        </span>
      </td>
      <td className="px-3 py-2 text-center">
        {i.occurrence_count}
        {i.occurrence_count > 1 && (
          <div className="text-xs text-splash-navy/60">last {formatEt(i.last_occurred_at).split(",")[0]}</div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {formatEt(i.first_reported_at)}
        {i.status !== "resolved" && <div className="text-xs text-splash-navy/60">{age === 0 ? "today" : `${age}d open`}</div>}
      </td>
      <td className="px-3 py-2 text-xs text-splash-navy/80">
        {i.it_ticket_no && <div>IT {i.it_ticket_no}</div>}
        {i.mx_request_id && <div>MX #{i.mx_request_id}</div>}
        {!i.it_ticket_no && !i.mx_request_id && <span className="text-splash-navy/40">-</span>}
      </td>
    </tr>
  );
}
