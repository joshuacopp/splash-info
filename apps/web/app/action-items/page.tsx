// Brief 176 — the action items page.
//
// TOP-LEVEL, not under /admin/*, for the same reason /workorders is: the
// audience is sites and RMs, not form administrators. Middleware gates it on
// the access cookie; the WORKER decides which items the caller can see, via
// email-on-locations. No role check here — re-deriving the rule would be a
// second implementation of it, and the two drift.

import Link from "next/link";

import { getMe } from "../_lib/me";
import { listActionItems } from "./_lib/worker-fetch";
import { STATUS_LABEL, type ActionItem } from "./_lib/types";
import ActionItemRow from "./_components/ActionItemRow";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ActionItemsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const statusFilter = one(sp.status);
  const locationFilter = one(sp.location);
  const showDone = statusFilter === "done" || one(sp.done) === "1";

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <Shell>
        <p className="text-sm text-splash-navy/70">
          <Link href="/login?next=/action-items" className="text-splash-blue underline">
            Sign in
          </Link>{" "}
          to see your site&rsquo;s action items.
        </p>
      </Shell>
    );
  }

  const resp = await listActionItems({
    location: locationFilter,
    status: statusFilter
  });

  // null is the worker refusing (no contact match anywhere), which is a
  // different thing from an empty list and deserves a different sentence.
  if (resp === null) {
    return (
      <Shell>
        <p className="text-sm text-splash-navy/70">
          Action items are shown to the people listed as a site, Regional
          Manager or Regional Director contact for a location. Your address
          isn&rsquo;t on any location right now, so there&rsquo;s nothing here.
        </p>
      </Shell>
    );
  }

  const items = resp.items;
  // Done work is history and shouldn't crowd out what's outstanding, but
  // hiding it entirely makes "did I already do this?" unanswerable — so it
  // collapses behind a toggle rather than disappearing.
  const outstanding = items.filter((i) => i.status !== "done");
  const done = items.filter((i) => i.status === "done");
  const overdue = outstanding.filter(
    (i) => i.due_date && i.due_date < new Date().toISOString().slice(0, 10)
  );

  const byLocation = new Map<string, ActionItem[]>();
  for (const i of outstanding) {
    const list = byLocation.get(i.location_code) ?? [];
    list.push(i);
    byLocation.set(i.location_code, list);
  }
  const locations = [...byLocation.keys()].sort();

  return (
    <Shell>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-splash-navy">Action Items</h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            {outstanding.length === 0
              ? "Nothing outstanding."
              : `${outstanding.length} outstanding${
                  overdue.length > 0 ? ` · ${overdue.length} overdue` : ""
                }`}
            {resp.scope === "scoped" && resp.locations.length > 0
              ? ` · ${resp.locations.length} site${resp.locations.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        {done.length > 0 ? (
          <Link
            href={showDone ? "/action-items" : "/action-items?done=1"}
            className="text-sm text-splash-blue underline"
          >
            {showDone ? "Hide" : "Show"} {done.length} completed
          </Link>
        ) : null}
      </div>

      {resp.limit_hit ? (
        <p className="mb-4 rounded-splash-sm border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Showing the first 500 items. Filter by site to narrow the list.
        </p>
      ) : null}

      {outstanding.length === 0 && !showDone ? (
        <p className="rounded-splash-md border border-gray-light bg-white p-6 text-sm text-splash-navy/70">
          No outstanding action items. New ones appear here when a Regional
          Manager flags something during a site visit.
        </p>
      ) : null}

      {locations.map((loc) => (
        <section key={loc} className="mb-6">
          {/* Grouped by site, and the header shows even for a single site --
              a site contact needs to know which location they're looking at
              as much as an RM covering twelve does. */}
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.15em] text-sudsy-blue">
            {loc}
          </h2>
          <ul className="space-y-2">
            {(byLocation.get(loc) ?? []).map((item) => (
              <ActionItemRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ))}

      {showDone && done.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.15em] text-splash-navy/50">
            {STATUS_LABEL.done} ({done.length})
          </h2>
          <ul className="space-y-2">
            {done.map((item) => (
              <ActionItemRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[900px] px-5 py-9">{children}</section>
  );
}
