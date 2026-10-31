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

/**
 * One ink per site, for the multi-series trend lines and the scatter dots.
 *
 * CHART.navy (#1c164e) and CHART.warn (#f1c61e) are deliberately NOT in here.
 * Navy is the goal reference line: a solid navy site line would be read as the
 * goal and silently mislead. The warn yellow is too low-contrast on white to
 * survive a 2px stroke — it reads as a smudge on screen and vanishes in print.
 * If you add a colour, check it against both of those failure modes first.
 */
export const SITE_COLOURS: readonly string[] = [
  "#2b3491",
  "#3dbeee",
  "#059669",
  "#dc2626",
  "#b45309",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#65a30d",
  "#ea580c",
  "#4338ca",
  "#78716c"
];

export interface SeriesStyle {
  colour: string;
  /** SVG strokeDasharray. Undefined = solid. */
  dash?: string;
}

/**
 * A stable colour + dash pattern for the Nth series.
 *
 * Colour cycles through SITE_COLOURS; every full cycle changes the dash, so
 * 12 colours x 3 dash patterns = 36 visually distinct series before anything
 * repeats. Past 36 two sites WILL look identical — if this chain ever gets
 * that big, the fix is filtering, not a longer palette.
 *
 * THE TRAP: assignment is purely BY INDEX. Nothing here is derived from the
 * site itself, so the caller must pass a stably-sorted list (site number, not
 * a rate or anything else that moves) or the colours reshuffle between page
 * loads and week-over-week screenshots stop being comparable.
 */
export function seriesStyle(index: number): SeriesStyle {
  const i = Math.abs(Math.trunc(index));
  const n = SITE_COLOURS.length;
  // ?? is unreachable given the modulo, but noUncheckedIndexedAccess is on and
  // a silent `undefined` stroke would render as black on every site at once.
  const colour = SITE_COLOURS[i % n] ?? CHART.blue;
  const band = Math.floor(i / n);
  if (band === 0) return { colour };
  return { colour, dash: band === 1 ? "5 3" : "1 3" };
}

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

export interface LegendItem {
  key: string;
  label: string;
  style: SeriesStyle;
  /**
   * `mark="dot"` only: draw the swatch hollow, matching a low-sample dot in
   * VolumeScatter. Ignored by the line mark, where a hollow line is nothing.
   */
  hollow?: boolean;
}

/**
 * Colour key for the per-site series.
 *
 * THE SWATCH HAS TO MATCH THE MARK IT EXPLAINS. `mark="line"` draws a real SVG
 * line, dash and all, because with 12+ sites the dash is half the identity of a
 * series and a solid chip would make two sites look like one. `mark="dot"`
 * draws a circle at VolumeScatter's own radii and its own hollow treatment, so
 * a reader can match a chip to a dot without translating between shapes.
 *
 * The chip layout is Tailwind because it's HTML, same as CaptureLegend; only
 * the swatch is SVG, where the literal-hex rule applies.
 */
export function SiteLegend({
  items,
  mark = "line"
}: {
  items: LegendItem[];
  mark?: "line" | "dot";
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-splash-navy/70">
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1.5">
          {mark === "dot" ? (
            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
              <circle
                cx={6}
                cy={6}
                r={it.hollow ? 4 : 5}
                fill={it.hollow ? "#ffffff" : it.style.colour}
                stroke={it.style.colour}
                strokeWidth={it.hollow ? 1.5 : 0}
                opacity={0.9}
              />
            </svg>
          ) : (
            <svg width={14} height={4} viewBox="0 0 14 4" aria-hidden="true">
              <line
                x1={0}
                x2={14}
                y1={2}
                y2={2}
                stroke={it.style.colour}
                strokeWidth={2}
                strokeLinecap="round"
                {...(it.style.dash ? { strokeDasharray: it.style.dash } : {})}
              />
            </svg>
          )}
          <span className="font-semibold">{it.label}</span>
        </span>
      ))}
    </div>
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

export interface TrendSeries {
  /** Stable across renders, e.g. String(location_id). Used as the React key. */
  key: string;
  /** Prefixes every hover label on this line, e.g. "binghamton · 122". */
  label: string;
  style: SeriesStyle;
  /**
   * SAME LENGTH and SAME ORDER as every other series in the chart. See the
   * shared-x-axis note on TrendChart — this is a caller contract, not a hint.
   */
  points: TrendPoint[];
}

/**
 * Consecutive non-null points, grouped into runs.
 *
 * Each run becomes its own polyline so a null day renders as a GAP. Joining
 * across it would invent a trend on a day nobody reported, which is precisely
 * the failure this whole scorecard exists to surface. Do not "fix" the broken
 * lines by interpolating.
 */
function splitRuns(points: TrendPoint[]): { i: number; v: number }[][] {
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
  return runs;
}

/**
 * One line per site across the window, with the goal drawn as a reference line.
 *
 * THE X-AXIS IS SHARED AND POSITIONAL. A point's x comes from its INDEX in the
 * points array, never from its date, so every series must be the same length
 * and in the same date order — including the null days. A caller that filters
 * out a site's empty days instead of passing them as null will slide that
 * site's whole line sideways and it will look like a real trend. The axis
 * labels are read off series[0] on the same assumption.
 *
 * The goal is a single shared line, so pass goal=null whenever the sites on
 * screen don't share one; a per-site goal belongs in RankBars, which draws its
 * own tick per row.
 */
export function TrendChart({
  series,
  goal,
  unit
}: {
  series: TrendSeries[];
  goal: number | null;
  unit: Unit;
}) {
  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 14, bottom: 30, left: 52 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Doubles as the noUncheckedIndexedAccess guard for every series[0] read.
  const axis = series[0];
  if (!axis) {
    return <ChartEmpty>No sites to chart in this window.</ChartEmpty>;
  }

  // The domain has to see EVERY series, not just the first — scaling to one
  // site would push the others off the top or squash them onto the axis.
  const values = series.flatMap((s) =>
    s.points.map((p) => p.value).filter((v): v is number => v !== null)
  );
  if (values.length === 0) {
    return <ChartEmpty>No days with a value in this window.</ChartEmpty>;
  }

  const days = axis.points.length;
  const [lo, hi] = domain(values, goal);
  const x = (i: number) =>
    PAD.left + (days === 1 ? plotW / 2 : (i * plotW) / (days - 1));
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const ticks = [lo, lo + (hi - lo) / 2, hi];
  // Thin the x labels so they never collide; 12 is about what fits at 720 wide.
  const labelEvery = Math.max(1, Math.ceil(days / 12));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Trend lines over ${days} days for ${series.length} site${
        series.length === 1 ? "" : "s"
      }${goal === null ? "" : `, against a goal of ${fmt(goal, unit)}`}`}
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

      {series.map((s) =>
        splitRuns(s.points).map((r, ri) => (
          <polyline
            key={`${s.key}-run-${ri}`}
            fill="none"
            stroke={s.style.colour}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            {...(s.style.dash ? { strokeDasharray: s.style.dash } : {})}
            points={r.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
          />
        ))
      )}

      {/* Markers are smaller than they were when this drew one line: at 20
          sites a 3.5px ring per point per site is a wall of circles and a few
          thousand DOM nodes. They stay because the <title> is the ONLY way to
          read an exact value on a chart with no client JS — dropping the
          markers would drop the tooltips with them. */}
      {series.map((s) =>
        s.points.map((p, i) =>
          p.value === null ? null : (
            <circle
              key={`${s.key}-${p.date}`}
              cx={x(i)}
              cy={y(p.value)}
              r={2.5}
              fill="#ffffff"
              stroke={s.style.colour}
              strokeWidth={2}
            >
              <title>
                {s.label} · {p.date} · {fmt(p.value, unit)}
                {p.note ? ` · ${p.note}` : ""}
              </title>
            </circle>
          )
        )
      )}

      {axis.points.map((p, i) =>
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
  /** Capture %, or null when there were no wash sales and no sign ups at all. */
  y: number | null;
  /**
   * The dot's LOCATION colour, from the same seriesStyle() call that colours
   * that site's trend line — a dot and a line only read as the same site if
   * both came from one stably-sorted index list. `dash` is ignored on dots.
   */
  style: SeriesStyle;
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
 * Dots are coloured BY LOCATION, not by capture tier. The question this chart
 * now answers is "where does each site's team sit relative to the others",
 * and tier colour fought location colour for the same visual channel: a green
 * dot next to a red one told you nothing about whether they were the same
 * store. Tier is still on screen — it's the dot's height against the goal
 * line, which is where a rate belongs. TIER_FILL stays in use by RankBars.
 *
 * Low-sample dots are drawn hollow for the same reason the tables sort them
 * last — visible, but not competing for attention with a graded figure. That's
 * orthogonal to location: a hollow dot keeps its site's colour on the stroke.
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
            fill={p.lowSample ? "#ffffff" : p.style.colour}
            stroke={p.style.colour}
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

/* ============================================================
 * 4. Overview charts
 *
 * The charts above all draw ONE MARK PER SITE OR PER GREETER, which is what
 * makes them good for drilling down and poor as an overview: with sixteen
 * sites the by-day lines are a tangle, and nothing on the page answered "how
 * are we doing overall, and where is the trouble" without reading. These
 * answer that from the same rows, with no extra reads.
 * ============================================================ */

/**
 * Two inks for the gained/lost and better/worse charts. Checked with the
 * dataviz palette validator (lightness band, colour-blind separation, 3:1
 * contrast on white) -- CHART.blue fails the lightness band and CHART.sudsy
 * fails contrast, which is why these aren't simply those two.
 *
 * Up is blue and down is orange, NOT green and red, because green/amber/red
 * already mean "against goal" everywhere on this page. A site that slipped but
 * is still over goal must not be painted red.
 */
export const POLARITY = {
  up: "#4352c0",
  down: "#d9631e"
} as const;

/** Square-swatch key, for charts whose marks are cells and bars, not lines. */
export function SwatchLegend({
  items
}: {
  items: { key: string; label: string; fill: string; hollow?: boolean }[];
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-splash-navy/70">
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1.5">
          <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
            <rect
              x={1}
              y={1}
              width={10}
              height={10}
              rx={2}
              fill={it.hollow ? "#ffffff" : it.fill}
              stroke={it.hollow ? CHART.muted : "none"}
              strokeWidth={it.hollow ? 1 : 0}
              {...(it.hollow ? { strokeDasharray: "2 1.5" } : {})}
            />
          </svg>
          <span className="font-semibold">{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------- 4a. Site x day grid ---------- */

/** What one site-day cell shows. */
export type HeatState = CaptureTier | "ungraded" | "missing";

export interface HeatCell {
  date: string;
  state: HeatState;
  hover: string;
}

export interface HeatRow {
  key: string;
  label: string;
  href: string;
  active?: boolean;
  /** SAME LENGTH and ORDER as every other row -- positional, like TrendChart. */
  cells: HeatCell[];
  /** Right-hand figure, e.g. the period capture rate. */
  summary: string;
}

export const HEAT_FILL: Record<HeatState, string> = {
  hit: CHART.success,
  near: CHART.warn,
  miss: CHART.deny,
  ungraded: CHART.grid,
  missing: "#ffffff"
};

/**
 * Every site, every day, one cell each, graded against that day's goal.
 *
 * The overview the per-site line chart can't be. A site missing every day is a
 * solid red row, one bad Tuesday is a single red cell, and a site that stopped
 * reporting is a run of empty outlined cells. Whether a problem keeps happening
 * or happened once is the question a manager actually has, and it reads here
 * without a single number.
 *
 * Missing days are drawn as OUTLINED EMPTY cells, never left out: dropping them
 * would slide a row's later days left and misdate them, and "didn't report" is
 * one of the things this grid exists to show.
 */
export function SiteDayHeatmap({ rows }: { rows: HeatRow[] }) {
  const first = rows[0];
  if (!first || first.cells.length === 0) {
    return <ChartEmpty>No sites reported in this window.</ChartEmpty>;
  }
  const days = first.cells.length;
  const W = 720;
  const LABEL_W = 140;
  const SUMMARY_W = 56;
  const GAP = 2;
  const plotW = W - LABEL_W - SUMMARY_W;
  // Capped so a 3-day window doesn't draw billboard-sized cells; bounded by the
  // plot width, so a 90-day window still fits -- cells get thin, never overflow.
  const cellW = Math.min(28, plotW / days);
  const ROW_H = 18;
  const HEAD = 16;
  const H = HEAD + rows.length * ROW_H + 4;
  const labelEvery = Math.max(1, Math.ceil((days * 34) / plotW));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Grid of ${rows.length} sites by ${days} days, each day coloured against goal`}
    >
      {first.cells.map((c, i) =>
        i % labelEvery === 0 ? (
          <text
            key={`h-${c.date}`}
            x={LABEL_W + i * cellW + cellW / 2}
            y={11}
            textAnchor="middle"
            fontSize={9}
            fill={CHART.muted}
          >
            {c.date.slice(5)}
          </text>
        ) : null
      )}

      {rows.map((r, ri) => {
        const top = HEAD + ri * ROW_H;
        const cellH = ROW_H - GAP;
        return (
          <a key={r.key} href={r.href}>
            <g>
              {r.active ? (
                <rect
                  x={0}
                  y={top - 1}
                  width={W}
                  height={ROW_H}
                  fill={CHART.sudsy}
                  opacity={0.14}
                  rx={3}
                />
              ) : null}
              <text
                x={LABEL_W - 8}
                y={top + cellH - 4}
                textAnchor="end"
                fontSize={10.5}
                fontWeight={600}
                fill={CHART.navy}
              >
                {r.label}
              </text>
              {r.cells.map((c, ci) => (
                <rect
                  key={c.date}
                  x={LABEL_W + ci * cellW + GAP / 2}
                  y={top}
                  width={Math.max(1, cellW - GAP)}
                  height={cellH}
                  rx={2}
                  fill={HEAT_FILL[c.state]}
                  stroke={c.state === "missing" ? CHART.muted : "none"}
                  strokeWidth={c.state === "missing" ? 1 : 0}
                  {...(c.state === "missing" ? { strokeDasharray: "2 1.5" } : {})}
                >
                  <title>{c.hover}</title>
                </rect>
              ))}
              <text
                x={W - SUMMARY_W + 8}
                y={top + cellH - 4}
                fontSize={10.5}
                fontWeight={700}
                fill={CHART.navy}
              >
                {r.summary}
              </text>
            </g>
          </a>
        );
      })}
    </svg>
  );
}

/* ---------- 4b. Members gained and lost by day ---------- */

export interface GainLossDay {
  date: string;
  label: string;
  /** Null = no site reported that day; nothing is drawn in that slot. */
  gained: number | null;
  lost: number | null;
  hover: string;
}

/**
 * Members in (up) and out (down) each day, from one shared zero line.
 *
 * ONE SCALE for both directions: an orange bar as tall as a blue one really is
 * as many cancellations as that bar is sign ups. Two charts would each scale to
 * their own maximum and could make a bad week look like a good one.
 */
export function GainLossBars({ days }: { days: GainLossDay[] }) {
  const reported = days.filter((d) => d.gained !== null || d.lost !== null);
  if (reported.length === 0) {
    return <ChartEmpty>No days with membership numbers in this window.</ChartEmpty>;
  }
  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 14, bottom: 26, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxUp = Math.max(1, ...days.map((d) => d.gained ?? 0));
  const maxDown = Math.max(1, ...days.map((d) => d.lost ?? 0));
  const unit = plotH / (maxUp + maxDown);
  const zeroY = PAD.top + maxUp * unit;
  const slot = plotW / days.length;
  const barW = Math.max(2, Math.min(24, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(days.length / 12));

  const ticks = [
    { k: "up", y: PAD.top, t: `+${Math.round(maxUp).toLocaleString()}`, zero: false },
    { k: "zero", y: zeroY, t: "0", zero: true },
    {
      k: "down",
      y: PAD.top + plotH,
      t: `−${Math.round(maxDown).toLocaleString()}`,
      zero: false
    }
  ];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Members gained and lost on each of ${days.length} days`}
    >
      {ticks.map((tk) => (
        <g key={tk.k}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={tk.y}
            y2={tk.y}
            stroke={tk.zero ? CHART.muted : CHART.grid}
            strokeWidth={1}
          />
          <text
            x={PAD.left - 8}
            y={tk.y + 4}
            textAnchor="end"
            fontSize={10}
            fill={CHART.muted}
          >
            {tk.t}
          </text>
        </g>
      ))}

      {days.map((d, i) => {
        const cx = PAD.left + i * slot + slot / 2;
        const upH = (d.gained ?? 0) * unit;
        const downH = (d.lost ?? 0) * unit;
        return (
          <g key={d.date}>
            <title>{d.hover}</title>
            {/* Full-height hit target, so a one-member day is still hoverable. */}
            <rect
              x={PAD.left + i * slot}
              y={PAD.top}
              width={slot}
              height={plotH}
              fill="transparent"
            />
            {upH > 0 ? (
              <rect
                x={cx - barW / 2}
                y={zeroY - upH}
                width={barW}
                height={Math.max(1, upH - 1)}
                rx={2}
                fill={POLARITY.up}
              />
            ) : null}
            {downH > 0 ? (
              <rect
                x={cx - barW / 2}
                y={zeroY + 1}
                width={barW}
                height={Math.max(1, downH - 1)}
                rx={2}
                fill={POLARITY.down}
              />
            ) : null}
            {i % labelEvery === 0 ? (
              <text
                x={cx}
                y={H - 8}
                textAnchor="middle"
                fontSize={10}
                fill={CHART.muted}
              >
                {d.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- 4c. Change since the prior period ---------- */

export interface ChangeRow {
  key: string;
  label: string;
  href: string;
  active?: boolean;
  prior: number | null;
  current: number | null;
  goal: number | null;
  hover: string;
}

/**
 * Each site's capture rate last period (hollow dot) and this period (filled
 * dot), joined by a line coloured by direction. The caller sorts; worst
 * decline first is the intended order.
 *
 * Shows what the ranking bars can't: which way each site is MOVING, and by how
 * much, against its own goal tick. A site at 31% looks fine in a ranking; a
 * site at 31% that was at 38% is the phone call to make today.
 */
export function ChangeDumbbell({ rows }: { rows: ChangeRow[] }) {
  if (rows.length === 0) {
    return <ChartEmpty>No sites reported in this window.</ChartEmpty>;
  }
  const ROW_H = 24;
  const W = 720;
  const LABEL_W = 150;
  const PAD_R = 110;
  const H = rows.length * ROW_H + 8;
  const plotW = W - LABEL_W - PAD_R;
  // Zoomed to the range actually in play, NOT from zero. These are dots, not
  // bars -- no length is being compared against a baseline -- and the moves
  // are a few points on rates in the 20s and 30s, so a 0-40% axis squashed
  // every change into a few pixels in testing. Goals are included so every
  // site's goal tick stays on the chart.
  const [lo, hi] = domain(
    rows.flatMap((r) =>
      [r.prior, r.current, r.goal].filter((v): v is number => v !== null)
    ),
    null
  );
  const sx = (v: number) => LABEL_W + ((v - lo) / (hi - lo)) * plotW;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Change in capture rate from the prior period for ${rows.length} sites`}
    >
      {rows.map((r, i) => {
        const cy = i * ROW_H + ROW_H / 2 + 4;
        const change =
          r.prior === null || r.current === null ? null : r.current - r.prior;
        const ink =
          change === null || Math.abs(change) < 0.05
            ? CHART.muted
            : change > 0
              ? POLARITY.up
              : POLARITY.down;
        const changeText =
          change === null
            ? r.current === null
              ? "no data"
              : "no prior"
            : Math.abs(change) < 0.05
              ? "no change"
              : `${change > 0 ? "+" : "−"}${Math.abs(change).toFixed(1)} pts`;
        return (
          <a key={r.key} href={r.href}>
            <g>
              <title>{r.hover}</title>
              {r.active ? (
                <rect
                  x={0}
                  y={cy - ROW_H / 2}
                  width={W}
                  height={ROW_H}
                  fill={CHART.sudsy}
                  opacity={0.14}
                  rx={4}
                />
              ) : null}
              <rect
                x={0}
                y={cy - ROW_H / 2}
                width={W}
                height={ROW_H}
                fill="transparent"
              />
              <text
                x={LABEL_W - 10}
                y={cy + 4}
                textAnchor="end"
                fontSize={11}
                fontWeight={600}
                fill={CHART.navy}
              >
                {r.label}
              </text>
              <line
                x1={LABEL_W}
                x2={LABEL_W + plotW}
                y1={cy}
                y2={cy}
                stroke={CHART.grid}
                strokeWidth={1}
              />
              {r.goal !== null ? (
                <line
                  x1={sx(r.goal)}
                  x2={sx(r.goal)}
                  y1={cy - 7}
                  y2={cy + 7}
                  stroke={CHART.navy}
                  strokeWidth={2}
                />
              ) : null}
              {r.prior !== null && r.current !== null ? (
                <line
                  x1={sx(r.prior)}
                  x2={sx(r.current)}
                  y1={cy}
                  y2={cy}
                  stroke={ink}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
              ) : null}
              {r.prior !== null ? (
                <circle
                  cx={sx(r.prior)}
                  cy={cy}
                  r={4}
                  fill="#ffffff"
                  stroke={CHART.muted}
                  strokeWidth={2}
                />
              ) : null}
              {r.current !== null ? (
                <circle
                  cx={sx(r.current)}
                  cy={cy}
                  r={5}
                  fill={ink}
                  stroke="#ffffff"
                  strokeWidth={2}
                />
              ) : null}
              <text
                x={W - PAD_R + 8}
                y={cy + 4}
                fontSize={11}
                fontWeight={700}
                fill={CHART.navy}
              >
                {r.current === null ? "—" : fmt(r.current, "pct")}
                <tspan dx={6} fontWeight={600} fill={CHART.muted}>
                  {changeText}
                </tspan>
              </text>
            </g>
          </a>
        );
      })}
    </svg>
  );
}
