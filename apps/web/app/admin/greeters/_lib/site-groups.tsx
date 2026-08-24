// Grouping a long table by site, shared by /admin/greeters and its report view.
//
// Lifted out of /admin/greeters when the report's greeter table was collapsed
// the same way. Shared rather than copied for the same reason the grading
// thresholds are: what's encoded here is an ORDERING RULE, not a layout choice.
// Sites read A-Z and greeters read best-capture-first because that is what the
// operators asked for; two pages that ranked the same greeters differently would
// each make the other look wrong, and nobody would know which to believe.
//
// Nothing in here is a client component. Both callers are server components and
// the collapse is a native <details>, so there is no state to hydrate — see the
// known limitation on SiteGroupBlock.

import type { ReactNode } from "react";

/**
 * One site's worth of rows, rendered as one collapsible block.
 *
 * KEYED ON site_number, NOT location_code. The number is what every other
 * system joins on; the code is a slug that has been observed to differ between
 * tables for the same site, and a site that arrived spelled two ways would
 * silently split into two blocks that each look complete. The code rides along
 * for the heading and for the A-Z ordering only.
 */
export interface SiteGroup<T> {
  siteNumber: number;
  locationCode: string;
  rows: T[];
}

/**
 * Bucket rows by site, A-Z by location code, each bucket ordered by `within`.
 *
 * Callers render one <table> PER GROUP rather than one table with group-header
 * rows, for two reasons: <details> cannot legally wrap a <tbody>, and a table
 * per group gets its own sticky <thead> for free.
 *
 * The input array is not mutated — each group owns a fresh array — because the
 * lists this runs over are also the ones the edit and chooser id lookups search.
 */
export function groupBySite<
  T extends { site_number: number; location_code: string }
>(rows: readonly T[], within: (a: T, b: T) => number): SiteGroup<T>[] {
  const bySite = new Map<number, SiteGroup<T>>();
  for (const row of rows) {
    const found = bySite.get(row.site_number);
    if (found) {
      found.rows.push(row);
    } else {
      bySite.set(row.site_number, {
        siteNumber: row.site_number,
        locationCode: row.location_code,
        rows: [row]
      });
    }
  }
  const groups = [...bySite.values()];
  groups.sort((a, b) => a.locationCode.localeCompare(b.locationCode));
  for (const group of groups) group.rows.sort(within);
  return groups;
}

/**
 * Capture % descending, WITH NULLS LAST.
 *
 * Written out rather than `(b.capture ?? 0) - (a.capture ?? 0)` or a bare
 * subtraction, both of which put the greeters with no measurable capture rate
 * at the top of their site — the naive version reads as "these are the best
 * performers" when it means "we could not grade these at all". A greeter with
 * no denominator is not a leader.
 */
export function compareCaptureDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Sorting on a display name that a bad row could still deliver empty. */
export function nameKey(value: string | null): string {
  return value ?? "";
}

/**
 * One site's collapsible block: a heading, then that site's own table.
 *
 * `open` IS NORMALLY TRUE ONLY WHEN THIS IS THE ONLY GROUP. Somebody who has
 * filtered down to one site has already said what they want to look at, and
 * making them click a disclosure triangle to see it is pure click tax. Past one
 * group the default flips, because the reason the grouping exists is that a
 * 400-row table is unreadable in one piece. Callers with a highlighted row —
 * the report's drill-through — pass true for that row's group as well, since a
 * highlight inside a shut block is invisible and reads as a dead link.
 *
 * THE SITE NUMBER LIVES HERE NOW. It used to be a mono sub-line under the
 * location code in every row's Site cell; the Site column is gone because the
 * heading IS the site, so the number came up here rather than being dropped.
 *
 * KNOWN LIMITATION, DELIBERATELY NOT SOLVED: which blocks are open resets on
 * every filter change and every navigation. This is a native <details> inside a
 * server component and nothing outside the DOM remembers its state. Persisting
 * it means a client component plus localStorage — considered, deferred, and not
 * worth converting either page for.
 */
export function SiteGroupBlock<T>({
  group,
  open,
  children
}: {
  group: SiteGroup<T>;
  open: boolean;
  children: ReactNode;
}) {
  const count = group.rows.length;
  // The separator is border-b + last:border-b-0, NOT border-t + first:. These
  // <details> are not the card's first child — the card's own title block is —
  // so a `first:` rule would never match, and the first group would double up
  // with the title block's bottom border.
  return (
    <details open={open} className="border-b border-gray-light last:border-b-0">
      <summary className="cursor-pointer list-item px-5 py-3 text-sm font-semibold text-splash-navy marker:text-splash-navy/50 hover:bg-splash-navy/5">
        {group.locationCode}
        <span className="ml-2 font-mono text-xs font-normal text-splash-navy/60">
          {group.siteNumber}
        </span>
        <span className="ml-2 text-xs font-normal text-splash-navy/60">
          {count === 1 ? "1 row" : `${count} rows`}
        </span>
      </summary>
      {children}
    </details>
  );
}
