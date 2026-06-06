// Brief 158a — IT promotions queue (/admin/promotions/queue).
//
// IT-only work queue. Server component; restricted to `super_admin | it`.
// Table view (vs. card grid on the dashboard) for the work-queue feel —
// columns hint at the data IT needs at a glance: priority, status, ready
// by, assignees, locations done, roadblocks, internal note preview.
//
// "Assigned to me" defaults OFF when the URL param is absent. Reasoning:
// promo_tickets rows are auto-created at promo-creation time (Brief 154's
// POST /promos seeds the 1:1 ticket alongside the promotion row), but
// they're unassigned until someone in IT picks them up. If the queue
// defaulted to "Assigned to me" ON, IT would never see incoming work —
// the queue would always look empty until someone else assigned them.
// Operators who want only their own plate toggle the checkbox or hit
// /admin/promotions/queue?assigned_to_me=1.

import Link from "next/link";
import { getMe } from "../../../_lib/me";
import {
  listPromos,
  type PromoListResponse
} from "../_lib/worker-fetch";
import PromoFilterBar from "../_components/PromoFilterBar";
import PromoStatusPill from "../_components/PromoStatusPill";
import PromoPriorityPill from "../_components/PromoPriorityPill";
import NoAccessCard from "../_components/NoAccessCard";
import { formatEst } from "../../jotform/_lib/format-est";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

const QUEUE_LIMIT = 100;

export default async function PromoQueuePage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard reason="signin" returnPath="/admin/promotions/queue" />
    );
  }
  if (session.promoRole !== "super_admin" && session.promoRole !== "it") {
    return <NoAccessCard reason="it-only" />;
  }

  const status = readStringParam(sp.status);
  const priority = readStringParam(sp.priority);
  const search = readStringParam(sp.search);
  // Default OFF when the param is absent so IT can see the unscoped backlog
  // (auto-created tickets with no assignees yet). Set ?assigned_to_me=1 to
  // narrow to just the caller's plate.
  const assignedToMe = sp.assigned_to_me === "1";

  let response: PromoListResponse | null = null;
  let fetchError: string | null = null;
  try {
    response = await listPromos({
      status,
      priority: priority as PromoListResponse["promos"][number]["priority"] | undefined,
      assignedToMe,
      search,
      limit: QUEUE_LIMIT
    });
    if (!response) {
      return <NoAccessCard reason="it-only" />;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Sort: priority desc (High → Medium → Low), then requested_go_live_date
  // asc, then created_at desc. Worker emits created_at.desc; we re-sort
  // here to satisfy the work-queue priority order.
  const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 } as const;
  const sorted = response
    ? [...response.promos].sort((a, b) => {
        const dp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (dp !== 0) return dp;
        if (a.requestedGoLiveDate !== b.requestedGoLiveDate) {
          return a.requestedGoLiveDate < b.requestedGoLiveDate ? -1 : 1;
        }
        return a.createdAt < b.createdAt ? 1 : -1;
      })
    : [];

  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/promotions"
          className="text-splash-blue hover:underline"
        >
          ← All promotions
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          IT
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">
          IT Promotions Queue
        </h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Items waiting on the IT team for scoping or build.
        </p>
      </div>

      <PromoFilterBar defaultAssignedToMe={false} />

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load queue: {fetchError}
        </p>
      )}

      {response && (
        <>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-splash-navy/55">
            {response.total} {response.total === 1 ? "promotion" : "promotions"}
            {assignedToMe && " · assigned to you"}
          </p>
          {sorted.length === 0 ? (
            <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
              {assignedToMe
                ? "No promotions assigned to you with these filters. Try toggling \"Assigned to me\" off to see the wider queue."
                : "No promotions match these filters."}
            </div>
          ) : (
            <QueueTable promos={sorted} />
          )}
        </>
      )}
    </section>
  );
}

function QueueTable({
  promos
}: {
  promos: PromoListResponse["promos"];
}) {
  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">Title</th>
            <th className="px-3 py-2 font-semibold">Priority</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Ready by</th>
            <th className="px-3 py-2 font-semibold">Go-live</th>
            <th className="px-3 py-2 font-semibold">Assignees</th>
            <th className="px-3 py-2 font-semibold">Locations done</th>
          </tr>
        </thead>
        <tbody>
          {promos.map((p) => {
            const ready = p.readyByDate
              ? formatEst(`${p.readyByDate}T00:00:00Z`).absolute
              : null;
            const goLive = formatEst(`${p.requestedGoLiveDate}T00:00:00Z`).absolute;
            return (
              <tr
                key={p.id}
                className="border-t border-gray-light hover:bg-sudsy-blue-soft/20"
              >
                <td className="px-3 py-2 align-top">
                  <Link
                    href={`/admin/promotions/${encodeURIComponent(p.id)}/ticket`}
                    className="font-semibold text-splash-blue hover:underline"
                  >
                    {p.title}
                  </Link>
                  <p className="text-[0.6875rem] text-splash-navy/55">
                    {p.promoType}
                  </p>
                </td>
                <td className="px-3 py-2 align-top">
                  <PromoPriorityPill priority={p.priority} size="sm" />
                </td>
                <td className="px-3 py-2 align-top">
                  <PromoStatusPill status={p.status} size="sm" />
                </td>
                <td
                  className="px-3 py-2 align-top text-splash-navy/80"
                  title={p.readyByDate ?? undefined}
                >
                  {ready ?? (
                    <span className="italic text-splash-navy/40">—</span>
                  )}
                </td>
                <td
                  className="px-3 py-2 align-top text-splash-navy/80"
                  title={p.requestedGoLiveDate}
                >
                  {goLive}
                </td>
                <td className="px-3 py-2 align-top text-splash-navy/80">
                  {p.assigneeCount === 0 ? (
                    <span className="italic text-amber-700">Unassigned</span>
                  ) : (
                    p.assigneeCount
                  )}
                </td>
                <td className="px-3 py-2 align-top text-splash-navy/80">
                  {p.completedLocationCount} / {p.locationCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
