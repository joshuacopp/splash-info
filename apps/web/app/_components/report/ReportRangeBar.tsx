// Date-range controls for a report (Brief 179): preset chips plus the
// existing custom from/to picker. Server component; the chips are plain links
// that rewrite the URL, and the page re-renders from the URL.
//
// URL contract (shared with the worker via @splash/report-kit
// parseReportParams): `range=<preset>` wins, else `from`/`to`, else the
// report's default. A chip clears from/to; applying a custom range clears
// `range` (DateRangePicker does that), so the URL never carries both.

import Link from "next/link";
import {
  RANGE_PRESET_LABELS,
  formatRangeLabel,
  type RangePreset,
  type ResolvedRange
} from "@splash/report-kit";

import { DateRangePicker } from "../DateRangePicker";

interface Props {
  presets: ReadonlyArray<RangePreset>;
  range: ResolvedRange;
  /** The page's current search params, so chips keep the other filters. */
  searchParams: Record<string, string | string[] | undefined>;
}

function hrefWith(
  sp: Props["searchParams"],
  set: Record<string, string | null>
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s != null && s !== "") next.set(k, s);
  }
  for (const [k, v] of Object.entries(set)) {
    if (v == null) next.delete(k);
    else next.set(k, v);
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "?";
}

export function ReportRangeBar({ presets, range, searchParams }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
        {presets.map((p) => {
          const active = range.preset === p;
          return (
            <Link
              key={p}
              href={hrefWith(searchParams, { range: p, from: null, to: null })}
              aria-current={active ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                active
                  ? "border-splash-navy bg-splash-navy text-white"
                  : "border-gray-light bg-white text-splash-navy hover:border-splash-blue"
              }`}
            >
              {RANGE_PRESET_LABELS[p]}
            </Link>
          );
        })}
      </div>
      <DateRangePicker defaultFromYmd={range.fromYmd} defaultToYmd={range.toYmd} />
      <p className="text-xs text-splash-navy/60">
        {formatRangeLabel(range)} (Eastern)
        {range.invalidInput && (
          <span className="ml-2 text-racecar-red">
            That date range wasn&rsquo;t valid, so the default is shown.
          </span>
        )}
      </p>
    </div>
  );
}
