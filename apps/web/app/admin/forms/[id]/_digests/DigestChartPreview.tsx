"use client";

// Live preview of a digest chart in the builder, on Recharts. Draws the SAME
// series the worker computed (the preview endpoint returns ChartData), in the
// same fixed colour order as the emailed PNG (apps/forms-worker/src/digests/
// chart-svg.ts), so what the admin sees is what recipients get -- the email
// version just has no hover.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { DigestChartData } from "../../_lib/worker-fetch";

// Validated categorical slots 1-7, fixed order; "Other" is gray. Keep in step with chart-svg.ts.
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
const OTHER_COLOR = "#a3a29c";
const OTHER_KEY = "__other__";
const GRID = "#e6e5e1";
const AXIS_TEXT = "#52514e";

function colorFor(key: string, i: number): string {
  return key === OTHER_KEY ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length]!;
}

function fmt(v: unknown, agg: DigestChartData["agg"]): string {
  if (typeof v !== "number") return "-";
  return v.toLocaleString("en-US", { maximumFractionDigits: agg === "avg" ? 1 : 2 });
}

export default function DigestChartPreview({ chart }: { chart: DigestChartData }) {
  const hasData = chart.series.some((s) => s.values.some((v) => (v ?? 0) > 0));
  if (!hasData) {
    return <p className="rounded border border-dashed border-gray-light p-4 text-sm text-splash-navy/60">No data for this chart in the preview period.</p>;
  }

  if (chart.type === "pie") {
    const values = chart.series[0]?.values ?? [];
    const data = chart.x.map((b, i) => ({ key: b.key, name: b.label, value: values[i] ?? 0 }));
    return (
      <div className="h-64 w-full">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={d.key} fill={colorFor(d.key, i)} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => fmt(v, chart.agg)} />
            <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12, color: AXIS_TEXT }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Recharts wants one object per x bucket with a property per series.
  const keyOf = (i: number) => `s${i}`;
  const rows = chart.x.map((b, xi) => {
    const r: Record<string, string | number | null> = { label: b.label };
    chart.series.forEach((s, si) => {
      r[keyOf(si)] = s.values[xi] ?? null;
    });
    return r;
  });
  const multi = chart.series.length > 1;
  const stacked = chart.type === "bar" && multi && chart.agg !== "avg";
  const common = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT }} tickLine={false} axisLine={{ stroke: AXIS_TEXT }} />
      <YAxis tick={{ fontSize: 11, fill: AXIS_TEXT }} tickLine={false} axisLine={false} width={48} allowDecimals={chart.agg === "avg"} />
      <Tooltip formatter={(v) => fmt(v, chart.agg)} />
      {multi ? <Legend verticalAlign="top" height={multi ? 36 : 0} wrapperStyle={{ fontSize: 12, color: AXIS_TEXT }} /> : null}
    </>
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        {chart.type === "bar" ? (
          <BarChart data={rows} barCategoryGap="25%">
            {common}
            {chart.series.map((s, si) => (
              <Bar
                key={s.key}
                dataKey={keyOf(si)}
                name={s.label}
                stackId={stacked ? "a" : undefined}
                fill={colorFor(s.key, si)}
                stroke="#fff"
                strokeWidth={stacked ? 1 : 0}
                radius={!stacked || si === chart.series.length - 1 ? [4, 4, 0, 0] : 0}
                maxBarSize={56}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        ) : (
          <LineChart data={rows}>
            {common}
            {chart.series.map((s, si) => (
              <Line
                key={s.key}
                dataKey={keyOf(si)}
                name={s.label}
                stroke={colorFor(s.key, si)}
                strokeWidth={2}
                dot={{ r: 3.5, strokeWidth: 2, stroke: "#fff", fill: colorFor(s.key, si) }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
