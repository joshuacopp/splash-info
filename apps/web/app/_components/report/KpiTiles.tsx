// KPI tiles for report pages (Brief 179). Tremor-style "metric card", built
// here because @tremor/react peers React 18 and apps/web runs React 19.
//
// Server-safe: no hooks, no functions in props, so a server page renders it
// directly. Values format through the kit's `formatValue`, the same formatter
// the report tables use, so a dollar figure reads the same in a tile and in a
// cell.

import { formatValue, type ColumnKind } from "@splash/report-kit";

export interface Kpi {
  label: string;
  value: number | null;
  kind?: ColumnKind;
  /** One short line under the value, e.g. what the number counts. */
  hint?: string;
}

export function KpiTiles({ items }: { items: ReadonlyArray<Kpi> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((k) => {
        const text = formatValue(k.kind ?? "number", k.value);
        return (
          <div
            key={k.label}
            className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card"
          >
            <div className="text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
              {k.label}
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-splash-navy">
              {text || "—"}
            </div>
            {k.hint && <div className="mt-0.5 text-xs text-splash-navy/60">{k.hint}</div>}
          </div>
        );
      })}
    </div>
  );
}
