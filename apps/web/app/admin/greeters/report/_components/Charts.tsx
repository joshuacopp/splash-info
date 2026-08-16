// Hand-rolled SVG charts for the greeter report.
//
// NO CHARTING LIBRARY, on purpose. Recharts/Chart.js would each add a client
// bundle to a page that is otherwise entirely server-rendered, and they'd
// approximate the brand palette rather than use it. These are ~200 lines of
// arithmetic and they render as static markup: no hydration, no layout shift,
// and a screenshot pasted into a deck looks exactly like the screen.
//
// Everything here is a SERVER component. Hover labels are native SVG <title>
// elements — the browser renders them as tooltips with no JavaScript at all.
// Drill-through is a plain <a href>, which SVG supports natively, so clicking a
// bar is a normal navigation and the state ends up in the URL where it can be
// shared and bookmarked.
//
// Colours are literal hex rather than Tailwind utilities. Tailwind's colour
// utilities do work on SVG, but the values here have to match a printed deck
// and a screenshot exactly, and a purged `fill-splash-blue` fails silently as
// black. They're copied from packages/config/tailwind.base.cjs — if the brand
// palette changes, change it there and here.

import type { ReactNode } from "react";
import type { CaptureTier } from "../../_lib/grading";

export const CHART = {
  navy: "#1c164e",
  blue: "#2b3491",
  sudsy: "#3dbeee",
  success: "#059669",
  warn: "#f1c61e",
  deny: "#dc2626",
  grid: "#dbdbdb",
  muted: "#8d89a6"
} as const;

/** Same three tiers as the pills in the tables, in chart-ink form. */
export const TIER_FILL: Record<CaptureTier, string> = {
  hit: CHART.success,
  near: CHART.warn,
  miss: CHART.deny
};

/* ============================================================
 * Shared chrome
 * ============================================================ */

export function ChartFrame({
  title,
  caption,
  children
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
      <h3 className="text-sm font-bold text-splash-navy">{title}</h3>
      {caption ? (
        <p className="mt-1 mb-3 text-xs text-splash-navy/60">{caption}</p>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </div>
  );
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-8 text-center text-sm text-splash-navy/60">
      {children}
    </p>
  );
}

/** Formats a value for an axis tick or a hover label. */
type Unit = "pct" | "money" | "count";

function fmt(value: number, unit: Unit): string {
  if (unit === "pct") return `${value.toFixed(1)}%`;
  if (unit === "money") return `$${value.toFixed(2)}`;
  return Math.round(value).toLocaleString();
}

/** Axis ticks want fewer decimals than hover labels. */
function tickFmt(value: number, unit: Unit): string {
  if (unit === "pct") return `${Math.round(value)}%`;
  if (unit === "money") return `$${value.toFixed(2)}`;
  return Math.round(value).toLocaleString();
}

/**
 * A padded [min, max] that always includes the goal line.
 *
 * The goal is forced into the domain because a chart that crops it is worse
 * than useless: a team beating goal by 20 points and one missing by 20 would
 * look identical, both just "a line near the top".
 */
function domain(values: number[], goal: number | null): [number, number] {
  const all = goal === null ? values : [...values, goal];
  if (all.length === 0) return [0, 1];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) {
    // A flat series still needs a band to draw in.
    hi = lo + Math.max(1, Math.abs(lo) * 0.1);
  }
  const pad = (hi - lo) * 0.12;
  lo = lo - pad;
  hi = hi + pad;
  // Never dip below zero for these metrics — a negative capture rate or D.O.B.
  // isn't a thing, and the empty space below the axis reads as real range.
  if (lo < 0) lo = 0;
  // Clamping only the low end can invert the range on an all-negative series.
  // Unreachable for capture % and D.O.B., but an inverted domain produces NaN
  // coordinates silently, and this function is the obvious one to reuse.
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

/* ============================================================
 * 1. Trend line
 * ============================================================ */

export interface TrendPoint {
  /** ISO business_date, used as the key and the hover label. */
  date: string;
  /** Short x-axis label, e.g. "08-11". */
  label: string;
  /** Null = the metric had no denominator that day. The line BREAKS here. */
  value: number | null;
  /** Extra context for the hover label, e.g. "412 wash sales". */
  note?: string;
}

/**
 * One metric a day across the window, with the goal drawn as a reference line.
 *
 * Null days break the line rather than being interpolated across. Drawing
 * straight through a gap would invent a trend on a day nobody reported, which
 * is precisely the failure this whole scorecard exists to surface.
 */
export function TrendChart({
  points,
  goal,
  unit,
  colour = CHART.blue
}: {
  points: TrendPoint[];
  goal: number | null;
  unit: Unit;
  colour?: string;
}) {
  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 14, bottom: 30, left: 52 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  if (values.length === 0) {
    return <ChartEmpty>No days with a value in this window.</ChartEmpty>;
  }

  const [lo, hi] = domain(values, goal);
  const x = (i: number) =>
    PAD.left + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Split into runs of consecutive non-null points; each run is its own
  // polyline so a gap renders as a gap.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ i, v: p.value });
    }
  });
  if (run.length) runs.push(run);

  const ticks = [lo, lo + (hi - lo) / 2, hi];
  // Thin the x labels so they never collide; 12 is about what fits at 720 wide.
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Trend line over ${points.length} days${
        goal === null ? "" : `, against a goal of ${fmt(goal, unit)}`
      }`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(t)}
            y2={y(t)}
            stroke={CHART.grid}
            strokeWidth={1}
          />
          <text
            x={PAD.left - 8}
            y={y(t) + 4}
            textAnchor="end"
            fontSize={10}
            fill={CHART.muted}
          >
            {tickFmt(t, unit)}
          </text>
        </g>
      ))}

      {goal !== null ? (
        <g>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(goal)}
            y2={y(goal)}
            stroke={CHART.navy}
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
          <text
            x={W - PAD.right}
            y={y(goal) - 5}
            textAnchor="end"
            fontSize={10}
            fontWeight={700}
            fill={CHART.navy}
          >
            Goal {fmt(goal, unit)}
          </text>
        </g>
      ) : null}

      {runs.map((r, ri) => (
        <polyline
          key={`run-${ri}`}
          fill="none"
          stroke={colour}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={r.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
        />
      ))}

      {points.map((p, i) =>
        p.value === null ? null : (
          <circle
            key={p.date}
            cx={x(i)}
            cy={y(p.value)}
            r={3.5}
            fill="#ffffff"
            stroke={colour}
            strokeWidth={2}
          >
            <title>
              {p.date} · {fmt(p.value, unit)}
              {p.note ? ` · ${p.note}` : ""}
            </title>
          </circle>
        )
      )}

      {points.map((p, i) =>
        i % labelEvery === 0 ? (
          <text
            key={`lbl-${p.date}`}
            x={x(i)}
            y={H - 10}
            textAnchor="middle"
            fontSize={10}
            fill={CHART.muted}
          >
            {p.label}
          </text>
        ) : null
      )}
    </svg>
  );
}

/* ============================================================
 * 2. Site ranking bars
 * ============================================================ */

export interface RankRow {
  key: string;
  /** Rendered in the left gutter; keep it short, LABEL_W is fixed. */
  label: string;
  /** Null = no denominator; the row is still drawn, as an explicit blank. */
  value: number | null;
  goal: number | null;
  tier: CaptureTier | null;
  hover: string;
  href: string;
  /** Highlight ring — the site currently drilled into. */
  active?: boolean;
}

/**
 * One horizontal bar per site, worst at the top.
 *
 * Horizontal rather than vertical because the labels are site names: a vertical
 * bar chart with 20 sites needs rotated text nobody can read at a glance.
 *
 * Each row carries its OWN goal tick, because goal windows are per site — a
 * single shared reference line would silently grade every site against
 * whichever one happened to be first.
 */
export function RankBars({
  rows,
  unit
}: {
  rows: RankRow[];
  unit: Unit;
}) {
  if (rows.length === 0) {
    return <ChartEmpty>No sites reported in this window.</ChartEmpty>;
  }

  const ROW_H = 26;
  const W = 720;
  const LABEL_W = 150;
  const PAD_R = 60;
  const H = rows.length * ROW_H + 24;
  const plotW = W - LABEL_W - PAD_R;

  const max = Math.max(
    1,
    ...rows.map((r) => Math.max(r.value ?? 0, r.goal ?? 0))
  );
  const scale = (v: number) => (v / max) * plotW;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Ranked bars for ${rows.length} site${rows.length === 1 ? "" : "s"}`}
    >
      {rows.map((r, i) => {
        const top = i * ROW_H + 8;
        const barH = 14;
        const w = r.value === null ? 0 : scale(r.value);
        return (
          <a key={r.key} href={r.href}>
            <g>
              {r.active ? (
                <rect
                  x={0}
                  y={top - 5}
                  width={W}
                  height={ROW_H}
                  fill={CHART.sudsy}
                  opacity={0.14}
                  rx={4}
                />
              ) : null}
              <title>{r.hover}</title>

              <text
                x={LABEL_W - 10}
                y={top + barH - 2}
                textAnchor="end"
                fontSize={11}
                fontWeight={600}
                fill={CHART.navy}
              >
                {r.label}
              </text>

              {/* Track, so a short bar still reads as "out of the same total". */}
              <rect
                x={LABEL_W}
                y={top}
                width={plotW}
                height={barH}
                fill={CHART.grid}
                opacity={0.35}
                rx={3}
              />
              {r.value === null ? (
                <text
                  x={LABEL_W + 6}
                  y={top + barH - 2}
                  fontSize={10}
                  fill={CHART.muted}
                >
                  no data
                </text>
              ) : (
                <rect
                  x={LABEL_W}
                  y={top}
                  width={Math.max(2, w)}
                  height={barH}
                  fill={r.tier ? TIER_FILL[r.tier] : CHART.blue}
                  rx={3}
                />
              )}

              {r.goal !== null ? (
                <line
                  x1={LABEL_W + scale(r.goal)}
                  x2={LABEL_W + scale(r.goal)}
                  y1={top - 2}
                  y2={top + barH + 2}
                  stroke={CHART.navy}
                  strokeWidth={2}
                />
              ) : null}

              <text
                x={W - PAD_R + 6}
                y={top + barH - 2}
                fontSize={11}
                fontWeight={700}
                fill={CHART.navy}
              >
                {r.value === null ? "—" : fmt(r.value, unit)}
              </text>
            </g>
          </a>
        );
      })}
    </svg>
  );
}

/* ============================================================
 * 3. Volume vs capture scatter
 * ============================================================ */

export interface ScatterPoint {
  key: string;
  /** Wash sales for the period — the volume behind the rate. */
  x: number;
  /** Capture %, or null when there were no wash sales at all. */
  y: number | null;
  tier: CaptureTier | null;
  hover: string;
  href: string;
  lowSample?: boolean;
}

/**
 * Every greeter as a dot: volume across, capture rate up.
 *
 * This chart exists to answer one question a ranked list cannot: is a low
 * capture rate a performance problem or an arithmetic one? A greeter at 12% on
 * 9 wash sales and a greeter at 12% on 900 sit at the same height in a table
 * and look equally bad. Here they sit at opposite ends of the x-axis, and the
 * difference is obvious without reading a single number.
 *
 * Low-sample dots are drawn hollow for the same reason the tables sort them
 * last — visible, but not competing for attention with a graded figure.
 */
export function VolumeScatter({
  points,
  goal
}: {
  points: ScatterPoint[];
  goal: number | null;
}) {
  const plotted = points.filter(
    (p): p is ScatterPoint & { y: number } => p.y !== null
  );
  if (plotted.length === 0) {
    return <ChartEmpty>No greeters with a capture rate in this window.</ChartEmpty>;
  }

  const W = 720;
  const H = 300;
  const PAD = { top: 14, right: 16, bottom: 38, left: 52 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const [lo, hi] = domain(
    plotted.map((p) => p.y),
    goal
  );
  const xMax = Math.max(1, ...plotted.map((p) => p.x));

  const x = (v: number) => PAD.left + (v / xMax) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const yTicks = [lo, lo + (hi - lo) / 2, hi];
  const xTicks = [0, xMax / 2, xMax];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Wash sales against capture rate, one dot per greeter"
    >
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(t)}
            y2={y(t)}
            stroke={CHART.grid}
          />
          <text
            x={PAD.left - 8}
            y={y(t) + 4}
            textAnchor="end"
            fontSize={10}
            fill={CHART.muted}
          >
            {tickFmt(t, "pct")}
          </text>
        </g>
      ))}

      {xTicks.map((t) => (
        <text
          key={`x${t}`}
          x={x(t)}
          y={H - 18}
          textAnchor="middle"
          fontSize={10}
          fill={CHART.muted}
        >
          {Math.round(t).toLocaleString()}
        </text>
      ))}
      <text
        x={PAD.left + plotW / 2}
        y={H - 4}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill={CHART.muted}
      >
        Wash sales in the period
      </text>

      {goal !== null ? (
        <g>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(goal)}
            y2={y(goal)}
            stroke={CHART.navy}
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
          <text
            x={W - PAD.right}
            y={y(goal) - 5}
            textAnchor="end"
            fontSize={10}
            fontWeight={700}
            fill={CHART.navy}
          >
            Goal {fmt(goal, "pct")}
          </text>
        </g>
      ) : null}

      {plotted.map((p) => (
        <a key={p.key} href={p.href}>
          <circle
            cx={x(p.x)}
            cy={y(p.y)}
            r={p.lowSample ? 4 : 5.5}
            fill={p.lowSample ? "#ffffff" : p.tier ? TIER_FILL[p.tier] : CHART.blue}
            stroke={p.tier ? TIER_FILL[p.tier] : CHART.blue}
            strokeWidth={p.lowSample ? 1.5 : 0}
            opacity={p.lowSample ? 0.9 : 0.82}
          >
            <title>{p.hover}</title>
          </circle>
        </a>
      ))}
    </svg>
  );
}
