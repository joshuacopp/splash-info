// Brief 176 — the action items page.
//
// TOP-LEVEL, not under /admin/*, for the same reason /workorders is: the
// audience is sites and RMs, not form administrators. Middleware gates it on
// the access cookie; the WORKER decides which items the caller can see, via
// email-on-locations. No role check here — re-deriving the rule would be a
// second implementation of it, and the two drift.

import Link from "next/link";

import { getMe } from "../_lib/me";
import { listActionItems, listActionItemNotes } from "./_lib/worker-fetch";
import { STATUS_LABEL, type ActionItem, type ActionItemNote } from "./_lib/types";
import ActionItemRow from "./_components/ActionItemRow";
import SiteTabs, { type SiteTab } from "./_components/SiteTabs";
import SiteOverview, { type SiteSummary } from "./_components/SiteOverview";
import AddItemForm from "./_components/AddItemForm";

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

  // Deliberately NOT scoped to ?location=. The tab counts describe sites the
  // caller is not currently looking at, so narrowing the fetch would report
  // every other site as clear -- the most misleading possible wrong answer on
  // a page whose job is telling you where to push.
  const resp = await listActionItems({ status: statusFilter });

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
  const today = new Date().toISOString().slice(0, 10);

  // Every site the caller can reach, not just the ones with items. A site with
  // nothing open is an answer ("clear"); omitting it reads as missing data.
  // For an admin, `resp.locations` is empty by design -- scope is "all" and
  // there is no list to enumerate -- so fall back to what the items show.
  const siteCodes = [
    ...new Set([...resp.locations, ...items.map((i) => i.location_code)])
  ].sort();
  const multiSite = siteCodes.length > 1;

  // An unknown or inaccessible ?location= resolves to the overview rather than
  // an empty list: the worker would refuse it anyway, and a blank page does
  // not explain itself.
  const activeSite =
    locationFilter && siteCodes.includes(locationFilter) ? locationFilter : null;

  function summarise(code: string): SiteSummary {
    const open = items.filter(
      (i) => i.location_code === code && i.status !== "done"
    );
    const due = open
      .map((i) => i.due_date)
      .filter((d): d is string => !!d)
      .sort();
    return {
      locationCode: code,
      open: open.length,
      overdue: open.filter((i) => i.due_date && i.due_date < today).length,
      nextDue: due[0] ?? null
    };
  }
  const summaries = siteCodes.map(summarise);
  // Worst first: most overdue, then most open. Alphabetical would bury the
  // site that needs pushing behind one that does not.
  const ranked = [...summaries].sort(
    (a, b) => b.overdue - a.overdue || b.open - a.open ||
      a.locationCode.localeCompare(b.locationCode)
  );
  // Tabs stay ALPHABETICAL even though the overview cards are ranked. A tab
  // strip that reshuffles as counts change destroys the muscle memory of
  // "my site is third from the left"; the overview is a triage view where
  // order is the whole point, and a tab strip is navigation where it is not.
  const tabs: SiteTab[] = summaries.map((s) => ({
    locationCode: s.locationCode,
    open: s.open,
    overdue: s.overdue
  }));

  // Scope everything below to the chosen site once one is picked.
  const scoped = activeSite
    ? items.filter((i) => i.location_code === activeSite)
    : items;
  // Done work is history and shouldn't crowd out what's outstanding, but
  // hiding it entirely makes "did I already do this?" unanswerable — so it
  // collapses behind a toggle rather than disappearing.
  const outstanding = scoped.filter((i) => i.status !== "done");
  const done = scoped.filter((i) => i.status === "done");
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

  const totalOpen = summaries.reduce((n, x) => n + x.open, 0);
  const totalOverdue = summaries.reduce((n, x) => n + x.overdue, 0);
  // The landing view for anyone covering more than one site. A single-site
  // contact goes straight to their list -- an overview of one card is a click
  // in front of the thing they came for.
  const showOverview = multiSite && activeSite === null && !showDone;

  // The site to add against: whichever tab is open, or the only one they have.
  // On the multi-site overview there is nothing to imply, so no form is shown
  // rather than a site dropdown that could be set wrong.
  const addSite =
    activeSite ?? (siteCodes.length === 1 ? (siteCodes[0] ?? null) : null);
  // The worker re-checks this; here it just avoids offering a form whose
  // submit would be refused. `can_edit` is per-row and there may be no rows
  // yet, so fall back to the same question the worker asks: does this caller
  // reach that site at all?
  const canAdd =
    addSite !== null &&
    (resp.scope === "all" || resp.locations.includes(addSite));

  // Threads only for the rows actually about to render -- never on the
  // overview, where no item rows exist, and never for the whole portfolio.
  // One request per visible item, in parallel, and fail-soft per item so a
  // single bad thread cannot take the worklist down with it.
  const visible = showOverview ? [] : [...outstanding, ...(showDone ? done : [])];
  const noteEntries = await Promise.all(
    visible.map(async (i) => [i.id, await listActionItemNotes(i.id)] as const)
  );
  const notesById = new Map<string, ActionItemNote[]>(noteEntries);

  return (
    <Shell>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-splash-navy">
            {activeSite ?? "Action Items"}
          </h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            {showOverview
              ? `${totalOpen} open across ${siteCodes.length} sites${
                  totalOverdue > 0 ? ` · ${totalOverdue} overdue` : ""
                }`
              : outstanding.length === 0
                ? "Nothing outstanding."
                : `${outstanding.length} outstanding${
                    overdue.length > 0 ? ` · ${overdue.length} overdue` : ""
                  }`}
          </p>
        </div>
        {done.length > 0 ? (
          <Link
            href={buildHref(activeSite, !showDone)}
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

      {multiSite ? (
        <SiteTabs
          tabs={tabs}
          active={activeSite}
          totalOpen={totalOpen}
          totalOverdue={totalOverdue}
        />
      ) : null}

      {showOverview ? <SiteOverview sites={ranked} /> : null}

      {!showOverview && canAdd && addSite ? (
        <AddItemForm locationCode={addSite} />
      ) : null}

      {!showOverview && outstanding.length === 0 && !showDone ? (
        <p className="rounded-splash-md border border-gray-light bg-white p-6 text-sm text-splash-navy/70">
          No outstanding action items. New ones appear here when a Regional
          Manager flags something during a site visit.
        </p>
      ) : null}

      {!showOverview && locations.map((loc) => (
        <section key={loc} className="mb-6">
          {/* Grouped by site, and the header shows even for a single site --
              a site contact needs to know which location they're looking at
              as much as an RM covering twelve does. */}
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.15em] text-sudsy-blue">
            {loc}
          </h2>
          <ul className="space-y-2">
            {(byLocation.get(loc) ?? []).map((item) => (
              <ActionItemRow
                key={item.id}
                item={item}
                notes={notesById.get(item.id) ?? []}
              />
            ))}
          </ul>
        </section>
      ))}

      {!showOverview && showDone && done.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.15em] text-splash-navy/50">
            {STATUS_LABEL.done} ({done.length})
          </h2>
          <ul className="space-y-2">
            {done.map((item) => (
              <ActionItemRow
                key={item.id}
                item={item}
                notes={notesById.get(item.id) ?? []}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}

/** Keeps the chosen site when toggling completed items, so the toggle does not
 *  quietly throw you back to the overview. */
function buildHref(site: string | null, withDone: boolean): string {
  const qs = new URLSearchParams();
  if (site) qs.set("location", site);
  if (withDone) qs.set("done", "1");
  const q = qs.toString();
  return q ? `/action-items?${q}` : "/action-items";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[900px] px-5 py-9">{children}</section>
  );
}
