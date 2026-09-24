// Site tabs, shown only to people who cover more than one location.
//
// A site contact has exactly one site; giving them a tab bar with one tab in
// it is chrome that says nothing. An RM covering twelve needs to work one site
// at a time, because "everything I am responsible for" in a single list is a
// pile, not a worklist.

import Link from "next/link";

export interface SiteTab {
  locationCode: string;
  open: number;
  overdue: number;
}

export default function SiteTabs({
  tabs,
  active,
  totalOpen,
  totalOverdue
}: {
  tabs: SiteTab[];
  /** null = the all-sites overview. */
  active: string | null;
  totalOpen: number;
  totalOverdue: number;
}) {
  return (
    <nav
      aria-label="Sites"
      className="mb-5 flex flex-wrap gap-2 border-b border-gray-light pb-3"
    >
      <TabLink
        href="/action-items"
        label="All sites"
        count={totalOpen}
        overdue={totalOverdue}
        active={active === null}
      />
      {tabs.map((t) => (
        <TabLink
          key={t.locationCode}
          href={`/action-items?location=${encodeURIComponent(t.locationCode)}`}
          label={t.locationCode}
          count={t.open}
          overdue={t.overdue}
          active={active === t.locationCode}
        />
      ))}
    </nav>
  );
}

function TabLink({
  href,
  label,
  count,
  overdue,
  active
}: {
  href: string;
  label: string;
  count: number;
  overdue: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      // Same reasoning as the dashboard tiles: every one of these re-renders a
      // force-dynamic page against the worker, and the visitor picks one.
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "inline-flex items-center gap-1.5 rounded-full border border-splash-blue bg-splash-blue px-3.5 py-1.5 text-sm font-bold text-white"
          : "inline-flex items-center gap-1.5 rounded-full border border-gray-light bg-white px-3.5 py-1.5 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
      }
    >
      <span>{label}</span>
      {/* A zero count is worth showing rather than hiding: "this site is
          clear" is information, and a missing badge reads as missing data. */}
      <span
        className={
          active
            ? "rounded-full bg-white/25 px-1.5 text-xs font-bold"
            : "rounded-full bg-gray-light px-1.5 text-xs font-bold text-splash-navy/70"
        }
      >
        {count}
      </span>
      {overdue > 0 && !active ? (
        <span
          title={`${overdue} overdue`}
          className="rounded-full bg-racecar-red/10 px-1.5 text-xs font-bold text-racecar-red"
        >
          {overdue}!
        </span>
      ) : null}
    </Link>
  );
}
