"use client";

// Horizontal stacked bar chart for report pages (Brief 179), on Recharts.
// Tremor-style, built here because @tremor/react peers React 18.
//
// One bar per category (e.g. a location), up to three stacked series. Rules
// it follows, so a second chart built on it reads the same:
//   - Series colours are categorical slots 1-3 in FIXED ORDER (blue, orange,
//     aqua). Those three pass the palette validator for colour-blind and
//     normal-vision separation; slot 3 is under 3:1 contrast on white, so the
//     legend is always shown and the page must keep a table of the same
//     numbers (the relief rule). Do not add a fourth series here -- fold it
//     into "Other" or use a second chart.
//   - Text is never painted in a series colour; swatches carry identity.
//   - Bars <= 24px, white 2px gap between segments, hairline solid gridlines,
//     the total labelled at the bar tip, a tooltip on hover.
//   - Rows are capped (`maxRows`); the caller says where the rest is.

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps
} from "recharts";

const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"] as const;
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const TEXT_SECONDARY = "#52514e";
const TEXT_MUTED = "#898781";
const BAR_PX = 18;
const ROW_PX = 30;

export interface StackedSeries {
  key: string;
  label: string;
}

export interface StackedBarChartProps {
  /** Rows: `label` plus one numeric field per series key. */
  rows: ReadonlyArray<{ label: string } & Record<string, number | string>>;
  series: readonly [StackedSeries, ...StackedSeries[]];
  /** Accessible name for the chart. */
  title: string;
  maxRows?: number;
}

type Datum = { label: string; __total: number } & Record<string, number | string>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function StackedBarChart({ rows, series, title, maxRows = 15 }: StackedBarChartProps) {
  const used = series.slice(0, SERIES_COLORS.length);
  const data: Datum[] = rows
    .map((r) => ({ ...r, __total: used.reduce((s, x) => s + num(r[x.key]), 0) }) as Datum)
    .filter((d) => d.__total > 0)
    .sort((a, b) => b.__total - a.__total || a.label.localeCompare(b.label));
  const shown = data.slice(0, maxRows);

  if (shown.length === 0) {
    return (
      <p className="rounded-splash-lg border border-gray-light bg-white p-5 text-sm text-splash-navy/70 shadow-splash-card">
        Nothing to chart for this period.
      </p>
    );
  }

  const last = used.length - 1;

  return (
    <figure className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-splash-navy/80" aria-label="Legend">
        {used.map((s, i) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: SERIES_COLORS[i] }}
            />
            {s.label}
          </li>
        ))}
      </ul>
      <div role="img" aria-label={title} style={{ height: shown.length * ROW_PX + 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={shown} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={GRID} strokeWidth={1} />
            <XAxis
              type="number"
              allowDecimals={false}
              tick={{ fill: TEXT_MUTED, fontSize: 11 }}
              axisLine={{ stroke: AXIS }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={140}
              tick={{ fill: TEXT_SECONDARY, fontSize: 12 }}
              axisLine={{ stroke: AXIS }}
              tickLine={false}
            />
            <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} content={<ChartTooltip series={used} />} />
            {used.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="stack"
                fill={SERIES_COLORS[i]}
                stroke="#ffffff"
                strokeWidth={1}
                barSize={BAR_PX}
                radius={i === last ? [0, 4, 4, 0] : 0}
                isAnimationActive={false}
              >
                {i === last && (
                  <LabelList
                    dataKey="__total"
                    position="right"
                    style={{ fill: TEXT_SECONDARY, fontSize: 11 }}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {data.length > shown.length && (
        <figcaption className="mt-2 text-xs text-splash-navy/60">
          Top {shown.length} of {data.length} by total.
        </figcaption>
      )}
    </figure>
  );
}

function ChartTooltip({
  active,
  payload,
  series
}: TooltipProps<number, string> & { series: ReadonlyArray<StackedSeries> }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload as Datum | undefined;
  if (!d) return null;
  return (
    <div className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-xs text-splash-navy shadow-splash-card">
      <div className="mb-1 font-semibold">{d.label}</div>
      {series.map((s, i) => (
        <div key={s.key} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-splash-navy/80">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: SERIES_COLORS[i] }}
            />
            {s.label}
          </span>
          <span className="tabular-nums">{num(d[s.key]).toLocaleString("en-US")}</span>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-4 border-t border-gray-light pt-1 font-semibold">
        <span>Total</span>
        <span className="tabular-nums">{d.__total.toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}
