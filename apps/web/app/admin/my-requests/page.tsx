// Brief 126 — My Requests page (/admin/my-requests).
//
// Cross-form list of submissions the caller submitted, with their current
// workflow status. Companion to Brief 121's Pending Approvals — Approvals
// shows items waiting on YOU; My Requests shows items YOU submitted with
// who's blocking them, what outcome they reached.
//
// Auth: any authenticated session. The worker query naturally returns an
// empty list for callers with no submissions, so no defense-in-depth gate
// beyond signin is needed.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import {
  listMyRequestsAdmin,
  type MyRequestItem,
  type MyRequestStatusFilter,
  type MyRequestStatusTint
} from "../forms/_lib/worker-fetch";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { formatEst } from "../jotform/_lib/format-est";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PAGE_SIZE = 50;

type TabId = "all" | "waiting" | "approved" | "denied";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting" },
  { id: "approved", label: "Approved" },
  { id: "denied", label: "Denied" }
];

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

function readTab(raw: string | string[] | undefined): TabId {
  const v = readStringParam(raw);
  if (v === "waiting" || v === "approved" || v === "denied") return v;
  return "all";
}

function readOffset(raw: string | string[] | undefined): number {
  const v = readStringParam(raw);
  if (!v) return 0;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function workerStatusFor(tab: TabId): MyRequestStatusFilter {
  if (tab === "waiting") return "waiting";
  if (tab === "approved" || tab === "denied") return "done";
  return "all";
}

function tintMatchesTab(tab: TabId, tint: MyRequestStatusTint): boolean {
  if (tab === "approved") return tint === "success";
  if (tab === "denied") return tint === "danger";
  return true;
}

export default async function MyRequestsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = readTab(sp.tab);
  const offset = readOffset(sp.offset);

  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/my-requests" />;
  }

  let res: Awaited<ReturnType<typeof listMyRequestsAdmin>>;
  let fetchError: string | null = null;
  try {
    res = await listMyRequestsAdmin({
      status: workerStatusFor(tab),
      limit: PAGE_SIZE,
      offset
    });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
    res = null;
  }

  const itemsAll = res?.items ?? [];
  // Approved / Denied tabs are convenience filters on top of `status=done`
  // — narrow client-side by tint per the brief.
  const items =
    tab === "approved" || tab === "denied"
      ? itemsAll.filter((it) => tintMatchesTab(tab, it.status_tint))
      : itemsAll;

  const limitHit = res?.limit_hit ?? false;
  const hasMore = (res?.items.length ?? 0) >= PAGE_SIZE;
  const hasPrev = offset > 0;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard/submissions"
          className="text-splash-blue hover:underline"
        >
          ← Submissions
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Workflow
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">My Requests</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Submissions you submitted — waiting on approval, approved, or denied.
        </p>
      </div>

      <nav className="mb-5 flex flex-wrap items-center gap-2 border-b border-gray-light pb-0">
        {TABS.map((t) => {
          const active = t.id === tab;
          // Tab change resets pagination — server-side count for a different
          // status query has nothing to do with the prior offset.
          const href =
            t.id === "all"
              ? "/admin/my-requests"
              : `/admin/my-requests?tab=${t.id}`;
          return (
            <Link
              key={t.id}
              href={href}
              className={`relative -mb-px rounded-t-splash-sm px-4 py-2 text-sm font-semibold ${
                active
                  ? "border border-b-white border-gray-light bg-white text-splash-navy"
                  : "text-splash-navy/60 hover:bg-white/40 hover:text-splash-navy"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load your requests: {fetchError}
        </p>
      )}

      {limitHit && (
        <p className="mb-5 rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          Showing the first {PAGE_SIZE.toLocaleString()} items on this page.
          Use Next to page through; if you keep seeing this banner the cap
          (500 rows per request) was hit — narrow your view by tab.
        </p>
      )}

      {res && items.length === 0 && !fetchError && (
        <EmptyState tab={tab} />
      )}

      {items.length > 0 && (
        <div className="overflow-hidden rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card">
          <ul className="divide-y divide-gray-light">
            {items.map((item) => (
              <RequestRow key={item.submission_id} item={item} />
            ))}
          </ul>
        </div>
      )}

      {(hasPrev || hasMore) && (
        <div className="mt-5 flex items-center justify-between text-sm">
          <PageLink
            label="← Prev"
            disabled={!hasPrev}
            offset={Math.max(0, offset - PAGE_SIZE)}
            tab={tab}
          />
          <span className="text-splash-navy/60">
            Showing {offset + 1}–{offset + items.length}
          </span>
          <PageLink
            label="Next →"
            disabled={!hasMore}
            offset={offset + PAGE_SIZE}
            tab={tab}
          />
        </div>
      )}
    </section>
  );
}

function PageLink({
  label,
  disabled,
  offset,
  tab
}: {
  label: string;
  disabled: boolean;
  offset: number;
  tab: TabId;
}) {
  if (disabled) {
    return (
      <span className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-splash-navy/40">
        {label}
      </span>
    );
  }
  const qs = new URLSearchParams();
  if (tab !== "all") qs.set("tab", tab);
  if (offset > 0) qs.set("offset", String(offset));
  const href = `/admin/my-requests${qs.toString() ? `?${qs}` : ""}`;
  return (
    <Link
      href={href}
      className="rounded-splash-sm border border-splash-blue bg-white px-3 py-1.5 font-semibold text-splash-blue hover:bg-splash-blue hover:text-white"
    >
      {label}
    </Link>
  );
}

function EmptyState({ tab }: { tab: TabId }) {
  let body: string;
  if (tab === "waiting") {
    body = "Nothing waiting on approval right now.";
  } else if (tab === "approved") {
    body = "No approved submissions in this view.";
  } else if (tab === "denied") {
    body = "No denied submissions in this view.";
  } else {
    body =
      "You haven't submitted any workflow-enabled forms yet. Visit /forms to fill one out.";
  }
  return (
    <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
      {body}
    </div>
  );
}

function RequestRow({ item }: { item: MyRequestItem }) {
  const submitted = formatEst(item.submitted_at);
  const reached = item.outcome_reached_at
    ? formatEst(item.outcome_reached_at)
    : null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2 text-sm text-splash-navy">
          <Link
            href={`/admin/forms/${encodeURIComponent(
              item.form_id
            )}/submissions`}
            className="truncate font-bold text-splash-navy hover:underline"
          >
            {item.form_title || (
              <span className="italic text-splash-navy/60">untitled</span>
            )}
          </Link>
          <StatusPill item={item} />
        </div>
        <p
          className="mt-0.5 text-xs text-splash-navy/60"
          title={submitted.absolute}
        >
          Submitted {submitted.relative || submitted.absolute}
        </p>
        {item.status_kind === "waiting" &&
          item.current_approver_emails.length > 0 && (
            <p className="mt-0.5 text-xs text-splash-navy/70">
              Waiting on{" "}
              <ApproverList emails={item.current_approver_emails} />
            </p>
          )}
        {item.status_kind === "outcome" && reached && (
          <p
            className="mt-0.5 text-xs text-splash-navy/70"
            title={reached.absolute}
          >
            Reached {reached.relative || reached.absolute}
          </p>
        )}
      </div>
      <Link
        href={item.detail_path}
        className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
      >
        Open
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </Link>
    </li>
  );
}

function StatusPill({ item }: { item: MyRequestItem }) {
  const cls = pillClassesFor(item.status_tint);
  // For in-flight rows, label both the stage and the approver in the pill
  // text gets noisy fast — keep the pill compact (stage label only) and
  // let the "Waiting on …" sub-line carry the approver. For outcomes, the
  // pill label IS the outcome.
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${cls}`}
    >
      {item.stage_label}
    </span>
  );
}

function pillClassesFor(tint: MyRequestStatusTint): string {
  switch (tint) {
    case "info":
      return "bg-sudsy-blue/15 text-sudsy-blue";
    case "success":
      return "bg-emerald-100 text-emerald-800";
    case "danger":
      return "bg-racecar-red/15 text-racecar-red";
    case "warning":
      return "bg-amber-100 text-amber-800";
    default:
      return "bg-gray-light text-splash-navy/70";
  }
}

function ApproverList({ emails }: { emails: string[] }) {
  // Caller's own email shouldn't appear here in practice — a submitter is
  // not also an approver on their own submission — but defense in depth:
  // surface "you" rather than the email if they happen to overlap. We
  // don't have the caller's email at render time without re-fetching
  // /api/me; the worker already filtered by submitter_email so all rows
  // belong to the caller, and we just render the approver email verbatim.
  if (emails.length === 1) {
    return <span className="font-medium">{emails[0]}</span>;
  }
  return (
    <span className="font-medium">
      {emails.slice(0, 3).join(", ")}
      {emails.length > 3 ? ` +${emails.length - 3} more` : ""}
    </span>
  );
}
