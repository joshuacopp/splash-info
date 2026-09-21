// Per-site KPI strip above the location blocks.
//
// Operator, 2026-09-21: "is it possible to have an up top KPI style breakdown
// of open reactive workorders per site by priority, plus the sites
// preventative percentage - but only display that to users that have more
// than one location visible to them".
//
// WHY IT IS GATED
//
//   A single-site operator already has this: their one location block is the
//   whole page, and its header carries the same counts. The panel earns its
//   space only when the question is "which of my sites needs me first", so it
//   renders at two or more rows and not before.
//
// WHY "--" AND NOT 0%
//
//   `pmOnTime.byLocation` deliberately OMITS locations with nothing due this
//   week -- see the comment on PmOnTimeResult. "No PM was due" and "PM was due
//   and none of it got done" are opposite facts, and rendering both as 0%
//   would accuse a site of failing at nothing. Absent reads as "no PM due".
//
//   The percentage itself is completed-over-due; the rule and the reason it
//   carries no traffic light live in ../_lib/pm-week.ts.
//
// WHY PILLS RATHER THAN A NUMERIC GRID
//
//   Seven numeric columns (site, four priorities, total, PM) do not fit a
//   phone in portrait, which is where these get read. Priorities render as
//   pills only when non-zero, so a quiet site is one short line and a busy one
//   is visibly busy at a glance. Sorted by high-priority count first, then
//   total, so the top of the list is the triage order.

import type { PmOnTime, PmOnTimeBucket } from "../_lib/worker-fetch";
import { pmPct, pmTitle, pmTone } from "../_lib/pm-week";

export interface SiteKpiRow {
  maintainx_id: number;
  location_pretty: string;
  /** Open reactive work orders at this site, counted by priority. */
  high: number;
  medium: number;
  low: number;
  none: number;
  total: number;
  /** Null when nothing preventative was due here this week. Not zero. */
  pm: PmOnTimeBucket | null;
}

/** Triage order: most high-priority work first, then most work, then name. */
function compareRows(a: SiteKpiRow, b: SiteKpiRow): number {
  if (a.high !== b.high) return b.high - a.high;
  if (a.total !== b.total) return b.total - a.total;
  return a.location_pretty.localeCompare(b.location_pretty);
}

export function SiteKpiPanel({
  rows,
  pmOnTime
}: {
  rows: SiteKpiRow[];
  /** Null on the MaintainX read path, which cannot see completed work orders.
   *  The preventative column is then dropped entirely rather than rendered as
   *  a column of dashes, which would read as "nothing due anywhere". */
  pmOnTime: PmOnTime | null;
}) {
  if (rows.length < 2) return null;

  const sorted = [...rows].sort(compareRows);
  const totals = sorted.reduce(
    (acc, r) => ({
      high: acc.high + r.high,
      medium: acc.medium + r.medium,
      low: acc.low + r.low,
      none: acc.none + r.none,
      total: acc.total + r.total
    }),
    { high: 0, medium: 0, low: 0, none: 0, total: 0 }
  );
  const showPm = pmOnTime !== null;

  return (
    <section className="mb-4 overflow-hidden rounded-splash-md border border-gray-light bg-white">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-light px-3 py-2">
        <h2 className="text-sm font-semibold text-splash-navy">
          Open reactive by site
        </h2>
        <p className="text-xs text-gray-500">
          {totals.total} open across {sorted.length} sites
          {totals.high > 0 ? ` · ${totals.high} high` : ""}
        </p>
      </header>

      <ul className="divide-y divide-gray-light">
        {sorted.map((row) => (
          <li
            key={row.maintainx_id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate font-semibold text-splash-navy">
              {row.location_pretty}
            </span>

            <span className="flex flex-wrap items-center gap-1">
              {row.total === 0 ? (
                <span className="text-xs text-gray-400">No open reactive</span>
              ) : (
                <>
                  <CountChip n={row.high} kind="HIGH" />
                  <CountChip n={row.medium} kind="MEDIUM" />
                  <CountChip n={row.low} kind="LOW" />
                  <CountChip n={row.none} kind="NONE" />
                  <span className="ml-1 text-xs tabular-nums text-gray-500">
                    {row.total} open
                  </span>
                </>
              )}
            </span>

            {showPm ? <PmCell bucket={row.pm} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const CHIP = {
  HIGH: { cls: "bg-splash-deny/20 text-splash-deny", label: "high" },
  MEDIUM: { cls: "bg-gray-light text-splash-navy/80", label: "medium" },
  LOW: { cls: "bg-sudsy-blue/20 text-splash-navy", label: "low" },
  NONE: { cls: "bg-gray-light/60 text-splash-navy/70", label: "no priority set" }
} as const;

type ChipKind = keyof typeof CHIP;

/** Renders nothing at zero -- an empty tier is noise, not information. Colours
 *  match PriorityPill so the strip and the rows below it read as one scale. */
function CountChip({ n, kind }: { n: number; kind: ChipKind }) {
  if (n === 0) return null;
  const chip = CHIP[kind];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${chip.cls}`}
      title={`${n} open ${chip.label} priority`}
    >
      {n} {kind === "NONE" ? "—" : chip.label}
    </span>
  );
}

/**
 * This site's preventative completion for the week, or a muted note when
 * nothing was due. Absent is NOT zero -- see the file header.
 */
function PmCell({ bucket }: { bucket: PmOnTimeBucket | null }) {
  if (bucket === null || bucket.due === 0) {
    return (
      <span
        className="w-24 text-right text-xs text-gray-400"
        title="No preventative work was due at this site this week."
      >
        no PM due
      </span>
    );
  }
  return (
    <span className="w-24 text-right">
      <span
        className={`inline-block rounded-full px-2 text-[11px] font-semibold tabular-nums ${pmTone(bucket)}`}
        title={pmTitle(bucket)}
      >
        {pmPct(bucket)}% PM
      </span>
    </span>
  );
}
