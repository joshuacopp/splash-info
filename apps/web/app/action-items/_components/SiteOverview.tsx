// The multi-site landing view: open items by site, worst first.
//
// An RM covering twelve locations opening a single flat list gets a pile, not
// a worklist -- the question they arrive with is "where do I need to push
// today", and that is answered by counts per site, not by the first ten rows
// of Batavia. Picking a site then gives them the real list.
//
// Sites with nothing open are still listed. "Brockport is clear" is an answer,
// and a site that silently disappears reads as missing data rather than as
// good news.

import Link from "next/link";

export interface SiteSummary {
  locationCode: string;
  open: number;
  overdue: number;
  /** Oldest due date among open items — null when nothing is open. */
  nextDue: string | null;
}

function formatDue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function SiteOverview({ sites }: { sites: SiteSummary[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sites.map((s) => {
        const clear = s.open === 0;
        return (
          <li key={s.locationCode}>
            <Link
              href={`/action-items?location=${encodeURIComponent(s.locationCode)}`}
              prefetch={false}
              className={`flex h-full flex-col justify-between rounded-splash-md border bg-white p-4 transition-shadow hover:shadow-splash-card ${
                s.overdue > 0 ? "border-racecar-red/40" : "border-gray-light"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-splash-navy">
                  {s.locationCode}
                </span>
                <span
                  className={
                    clear
                      ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800"
                      : "rounded-full bg-splash-navy px-2 py-0.5 text-xs font-bold text-white"
                  }
                >
                  {clear ? "Clear" : s.open}
                </span>
              </div>
              <p className="mt-2 text-xs text-splash-navy/60">
                {clear ? (
                  "Nothing outstanding"
                ) : (
                  <>
                    {s.open} open
                    {s.overdue > 0 ? (
                      <span className="font-bold text-racecar-red">
                        {" "}
                        · {s.overdue} overdue
                      </span>
                    ) : s.nextDue ? (
                      <> · next due {formatDue(s.nextDue)}</>
                    ) : null}
                  </>
                )}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
