// Brief 121 — Pending Approvals page (/admin/approvals).
//
// Cross-form list of every submission where the caller's session email is
// in `current_approver_emails` (the GIN-indexed denormalization Brief 120
// landed). Drill-through to the per-submission detail page is where the
// caller actually approves/denies via Brief 120's transition modal.
//
// Auth posture: any authenticated session can hit this page. The worker
// query naturally returns an empty list for callers who aren't on any
// approver list (no defense-in-depth gate needed). Admin-tier callers
// can flip `?scope=all` to see every pending approval in the org —
// useful for ops oversight.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import {
  listPendingApprovalsAdmin,
  type PendingApprovalItem
} from "../forms/_lib/worker-fetch";
import NoAccessCard from "../forms/_components/NoAccessCard";

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

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  if (diff < MIN_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.round(diff / MIN_MS)} min ago`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)} hr ago`;
  if (diff < MONTH_MS) return `${Math.round(diff / DAY_MS)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export default async function PendingApprovalsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const scopeParam = readStringParam(sp.scope);

  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/approvals" />;
  }

  const isAdminTier =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";

  // ?scope=all is admin-only. Non-admins get silently coerced back to
  // "me" — the worker would do the same, but doing it here keeps the
  // toggle UI honest.
  const wantsAll = scopeParam === "all" && isAdminTier;

  let res: Awaited<ReturnType<typeof listPendingApprovalsAdmin>>;
  let fetchError: string | null = null;
  try {
    res = await listPendingApprovalsAdmin({ all: wantsAll });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
    res = null;
  }

  if (res === null && !fetchError) {
    return <NoAccessCard reason="forbidden" />;
  }

  // Group by form. Forms with more items float to the top; ties break
  // alphabetically. Within a form, items are submitted_at desc (already
  // sorted server-side).
  const byForm = new Map<string, { title: string; items: PendingApprovalItem[] }>();
  if (res) {
    for (const item of res.items) {
      let bucket = byForm.get(item.form_id);
      if (!bucket) {
        bucket = { title: item.form_title, items: [] };
        byForm.set(item.form_id, bucket);
      }
      bucket.items.push(item);
    }
  }
  const groups = Array.from(byForm.entries())
    .map(([form_id, bucket]) => ({ form_id, ...bucket }))
    .sort((a, b) =>
      b.items.length - a.items.length || a.title.localeCompare(b.title)
    );

  const totalCount = res?.total ?? 0;
  const limitHit = res?.limit_hit ?? false;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard/operations"
          className="text-splash-blue hover:underline"
        >
          ← Operations
        </Link>
      </div>

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Workflow
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Pending Approvals</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          {wantsAll
            ? "Every pending approval across the org. Click Review to view details and approve or decline."
            : "Submissions waiting on your approval. Click Review to view details and approve or decline."}
        </p>
      </div>

      {isAdminTier && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm">
          <span className="font-semibold uppercase tracking-wide text-splash-navy/70">
            View
          </span>
          <Link
            href="/admin/approvals"
            className={`rounded-splash-sm px-3 py-1 text-sm font-semibold ${
              wantsAll
                ? "text-splash-navy/70 hover:bg-gray-light"
                : "bg-splash-navy text-white"
            }`}
          >
            Mine ({wantsAll ? "—" : totalCount})
          </Link>
          <Link
            href="/admin/approvals?scope=all"
            className={`rounded-splash-sm px-3 py-1 text-sm font-semibold ${
              wantsAll
                ? "bg-splash-navy text-white"
                : "text-splash-navy/70 hover:bg-gray-light"
            }`}
          >
            All Approvals
          </Link>
        </div>
      )}

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load pending approvals: {fetchError}
        </p>
      )}

      {limitHit && (
        <p className="mb-5 rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          Showing the first {totalCount.toLocaleString()} pending items. Narrow
          your scope or transition some items to see the rest.
        </p>
      )}

      {res && groups.length === 0 && !fetchError && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
          {wantsAll
            ? "No pending approvals across the org."
            : "No pending approvals — you're all caught up."}
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <FormGroup
              key={group.form_id}
              formId={group.form_id}
              title={group.title}
              items={group.items}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FormGroup({
  formId,
  title,
  items
}: {
  formId: string;
  title: string;
  items: PendingApprovalItem[];
}) {
  return (
    <div className="overflow-hidden rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card">
      <div className="flex items-center justify-between border-b border-splash-navy/10 bg-splash-navy/5 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold text-splash-navy">
            {title || <span className="italic text-splash-navy/60">untitled</span>}
          </h2>
          <span className="rounded-full bg-splash-blue/10 px-2.5 py-0.5 text-xs font-bold text-splash-blue">
            {items.length} pending
          </span>
        </div>
        <Link
          href={`/admin/forms/${encodeURIComponent(formId)}/submissions`}
          className="text-xs font-semibold uppercase tracking-wide text-splash-blue hover:underline"
        >
          All submissions →
        </Link>
      </div>

      <ul className="divide-y divide-gray-light">
        {items.map((item) => (
          <li
            key={item.submission_id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2 text-sm text-splash-navy">
                <StagePill label={item.stage_label} />
                {item.approver_resolution_status === "empty" && (
                  <UnresolvedApproverPill />
                )}
                {item.submitter_email ? (
                  <span className="truncate font-medium">
                    {item.submitter_email}
                  </span>
                ) : (
                  <span className="italic text-splash-navy/60">anonymous</span>
                )}
                {item.location_code && (
                  <span className="text-xs text-splash-navy/70">
                    @ {item.location_code}
                  </span>
                )}
              </div>
              <p
                className="mt-0.5 text-xs text-splash-navy/60"
                title={item.submitted_at}
              >
                Submitted {relativeTime(item.submitted_at)}
              </p>
            </div>
            <Link
              href={`${item.review_path}?from=approvals`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Review
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
        ))}
      </ul>
    </div>
  );
}

function StagePill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide text-amber-800">
      {label}
    </span>
  );
}

function UnresolvedApproverPill() {
  return (
    <span
      className="inline-flex items-center rounded-full bg-racecar-red/10 px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide text-racecar-red ring-1 ring-racecar-red/40"
      title="The approver_source on this stage resolved to no emails. Check the form's workflow configuration."
    >
      ⚠ No approver resolved
    </span>
  );
}
