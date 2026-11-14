// Digest aggregation -- pure functions from submissions to chart series and
// table rows. No I/O, so the same code serves the cron send, the "send me a
// test" button and the live preview in the builder, and is unit-testable.
//
// Buckets are EASTERN calendar days of `submitted_at` (period.ts explains
// why Eastern). Payload values are read by `field.key`, never `field.id` --
// CLAUDE.md, Brief 131.

import type { DigestChart, DigestDimension, DigestMetric, DigestTable, Field } from "@splash/forms-schema";
import { addDays, easternYmdOf, isoWeekdayOf, shortDate, type DigestPeriod } from "./period.js";

export interface DigestSubmission {
  id: string;
  submitted_at: string;
  location_code: string | null;
  payload: Record<string, unknown>;
}

export interface SiteInfo {
  code: string;
  name: string;
  number: string | null;
}

export interface AggregateContext {
  fields: Field[];
  sites: Map<string, SiteInfo>;
  period: DigestPeriod;
}

export interface Bucket {
  key: string;
  label: string;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** One per x bucket; null = no data (an average over nothing). */
  values: (number | null)[];
}

export interface ChartData {
  type: DigestChart["type"];
  agg: DigestMetric["agg"];
  title: string;
  xLabel: string;
  yLabel: string;
  x: Bucket[];
  series: ChartSeries[];
}

/** Categorical slots are fixed order (dataviz rule); past 7 the rest fold into "Other". */
export const MAX_SERIES = 7;
export const OTHER_KEY = "__other__";
const BLANK = "(blank)";

// --- field helpers -------------------------------------------------------------

function fieldByKey(ctx: AggregateContext, key: string): Field | undefined {
  return ctx.fields.find((f) => f.key === key);
}

function optionsOf(f: Field | undefined): { label: string; value: string }[] {
  if (!f) return [];
  const o = (f as { options?: { label: string; value: string }[] }).options;
  return Array.isArray(o) ? o : [];
}

export function fieldLabel(ctx: AggregateContext, key: string): string {
  return fieldByKey(ctx, key)?.label ?? key;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** One-line display of any payload value. */
export function displayValue(ctx: AggregateContext, key: string, v: unknown): string {
  if (v == null || v === "") return "";
  const f = fieldByKey(ctx, key);
  const opts = optionsOf(f);
  const label = (x: string) => opts.find((o) => o.value === x)?.label ?? x;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? label(x) : "")).filter(Boolean).join(", ");
  if (typeof v === "string") return opts.length ? label(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const name = (v as { name?: unknown }).name;
    if (typeof name === "string") return name; // employee picker
  }
  return "";
}

export function metricLabel(ctx: AggregateContext, m: DigestMetric): string {
  if (m.agg === "count") return "Submissions";
  const l = fieldLabel(ctx, m.field_key ?? "");
  return m.agg === "avg" ? `Average ${lowerFirst(l)}` : l;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

export function dimensionLabel(ctx: AggregateContext, d: DigestDimension): string {
  if (d === "day") return "Day";
  if (d === "week") return "Week";
  if (d === "month") return "Month";
  if (d === "site") return "Site";
  return fieldLabel(ctx, d.slice(6));
}

// --- buckets ----------------------------------------------------------------------

function siteName(ctx: AggregateContext, code: string | null): string {
  if (!code) return "(no site)";
  return ctx.sites.get(code)?.name ?? code;
}

const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(ymd: string): string {
  return `${DOW[isoWeekdayOf(ymd)]} ${shortDate(ymd)}`;
}
function weekKey(ymd: string): string {
  return addDays(ymd, 1 - isoWeekdayOf(ymd));
}
function monthLabel(ym: string): string {
  return `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

/** The bucket keys a submission falls in for a dimension (a multi answer may hit several). */
export function keysOf(ctx: AggregateContext, s: DigestSubmission, d: DigestDimension): string[] {
  if (d === "day") return [easternYmdOf(s.submitted_at)];
  if (d === "week") return [weekKey(easternYmdOf(s.submitted_at))];
  if (d === "month") return [easternYmdOf(s.submitted_at).slice(0, 7)];
  if (d === "site") return [s.location_code ?? ""];
  const v = s.payload[d.slice(6)];
  if (Array.isArray(v)) {
    const ks = v.filter((x): x is string => typeof x === "string" && x !== "");
    return ks.length ? ks : [BLANK];
  }
  const one = displayRaw(v);
  return [one === "" ? BLANK : one];
}

function displayRaw(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (typeof v === "object" && typeof (v as { name?: unknown }).name === "string") return (v as { name: string }).name;
  return "";
}

/**
 * Ordered buckets for a dimension. Time dimensions list EVERY bucket in the
 * period (a day with no salt is a real zero, and dropping it would bend a line
 * chart across the gap); the others list only what occurs.
 */
export function bucketsFor(ctx: AggregateContext, subs: DigestSubmission[], d: DigestDimension): Bucket[] {
  const { from, to } = ctx.period;
  if (d === "day") {
    const out: Bucket[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) out.push({ key: day, label: dayLabel(day) });
    return out;
  }
  if (d === "week") {
    const out: Bucket[] = [];
    for (let w = weekKey(from); w <= to; w = addDays(w, 7)) out.push({ key: w, label: `Week of ${shortDate(w)}` });
    return out;
  }
  if (d === "month") {
    const out: Bucket[] = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(`${m}-28`, 7).slice(0, 7)) {
      out.push({ key: m, label: monthLabel(m) });
    }
    return out;
  }
  const seen = new Set<string>();
  for (const s of subs) for (const k of keysOf(ctx, s, d)) seen.add(k);
  if (d === "site") {
    return [...seen]
      .map((k) => ({ key: k, label: siteName(ctx, k || null) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  const key = d.slice(6);
  const opts = optionsOf(fieldByKey(ctx, key));
  const ordered: Bucket[] = opts.filter((o) => seen.has(o.value)).map((o) => ({ key: o.value, label: o.label }));
  const rest = [...seen].filter((k) => !opts.some((o) => o.value === k)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...rest.map((k) => ({ key: k, label: k }))];
}

// --- metric accumulation --------------------------------------------------------

interface Acc {
  sum: number;
  n: number;
}

function contribution(s: DigestSubmission, m: DigestMetric): number | null {
  if (m.agg === "count") return 1;
  return toNumber(s.payload[m.field_key ?? ""]);
}

function finish(acc: Acc | undefined, m: DigestMetric): number | null {
  if (!acc || acc.n === 0) return m.agg === "avg" ? null : 0;
  return m.agg === "avg" ? acc.sum / acc.n : acc.sum;
}

function add(map: Map<string, Acc>, key: string, v: number | null) {
  if (v == null) return;
  const a = map.get(key) ?? { sum: 0, n: 0 };
  a.sum += v;
  a.n += 1;
  map.set(key, a);
}

// --- charts ----------------------------------------------------------------------------

export function chartData(ctx: AggregateContext, subs: DigestSubmission[], c: DigestChart): ChartData {
  const yLabel = metricLabel(ctx, c.y);
  const xLabel = dimensionLabel(ctx, c.x);
  const title = c.title?.trim() || (c.split ? `${yLabel} by ${lowerFirst(xLabel)} and ${lowerFirst(dimensionLabel(ctx, c.split))}` : `${yLabel} by ${lowerFirst(xLabel)}`);
  let x = bucketsFor(ctx, subs, c.x);

  if (c.type === "pie" || !c.split) {
    const cells = new Map<string, Acc>();
    for (const s of subs) {
      const v = contribution(s, c.y);
      for (const k of keysOf(ctx, s, c.x)) add(cells, k, v);
    }
    let values = x.map((b) => finish(cells.get(b.key), c.y));
    if (c.type === "pie") {
      // A pie is shares of a whole: drop empty slices, largest first, fold the tail.
      let slices = x
        .map((b, i) => ({ b, v: values[i] ?? 0 }))
        .filter((p) => p.v > 0)
        .sort((a, b) => b.v - a.v);
      if (slices.length > MAX_SERIES + 1) {
        const other = slices.slice(MAX_SERIES).reduce((t, p) => t + p.v, 0);
        slices = [...slices.slice(0, MAX_SERIES), { b: { key: OTHER_KEY, label: "Other" }, v: other }];
      }
      x = slices.map((p) => p.b);
      values = slices.map((p) => p.v);
    }
    return { type: c.type, agg: c.y.agg, title, xLabel, yLabel, x, series: [{ key: "__all__", label: yLabel, values }] };
  }

  // Split: one series per split bucket, top MAX_SERIES by total, rest -> Other.
  const split = c.split;
  const cells = new Map<string, Map<string, Acc>>();
  const totals = new Map<string, Acc>();
  for (const s of subs) {
    const v = contribution(s, c.y);
    for (const sk of keysOf(ctx, s, split)) {
      const m = cells.get(sk) ?? new Map<string, Acc>();
      for (const xk of keysOf(ctx, s, c.x)) add(m, xk, v);
      cells.set(sk, m);
      add(totals, sk, v);
    }
  }
  const splitBuckets = bucketsFor(ctx, subs, split).filter((b) => cells.has(b.key));
  const ranked = [...splitBuckets].sort((a, b) => (totals.get(b.key)?.sum ?? 0) - (totals.get(a.key)?.sum ?? 0));
  const keep = ranked.length > MAX_SERIES + 1 ? new Set(ranked.slice(0, MAX_SERIES).map((b) => b.key)) : null;

  const series: ChartSeries[] = splitBuckets
    .filter((b) => !keep || keep.has(b.key))
    .map((b) => ({ key: b.key, label: b.label, values: x.map((xb) => finish(cells.get(b.key)?.get(xb.key), c.y)) }));

  if (keep) {
    // "Other" is recomputed from the submissions, not summed from per-series
    // values: an average of averages would be wrong.
    const other = new Map<string, Acc>();
    for (const s of subs) {
      const v = contribution(s, c.y);
      if (keysOf(ctx, s, split).every((k) => keep.has(k))) continue;
      for (const xk of keysOf(ctx, s, c.x)) add(other, xk, v);
    }
    series.push({ key: OTHER_KEY, label: "Other", values: x.map((xb) => finish(other.get(xb.key), c.y)) });
  }
  return { type: c.type, agg: c.y.agg, title, xLabel, yLabel, x, series };
}

// --- tables ---------------------------------------------------------------------------

export interface TableSection {
  title?: string;
  rows: string[][];
  total?: string[];
}

export interface TableData {
  columns: string[];
  /** Columns from this index on are numbers (right-aligned). */
  numericFrom: number;
  sections: TableSection[];
  grandTotal?: string[];
}

export function formatNumber(v: number | null, agg: DigestMetric["agg"]): string {
  if (v == null) return "-";
  const digits = agg === "avg" ? 1 : Number.isInteger(v) ? 0 : 2;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function metricCells(subs: DigestSubmission[], metrics: DigestMetric[]): string[] {
  return metrics.map((m) => {
    const acc: Acc = { sum: 0, n: 0 };
    for (const s of subs) {
      const v = contribution(s, m);
      if (v != null) {
        acc.sum += v;
        acc.n += 1;
      }
    }
    return formatNumber(finish(acc, m), m.agg);
  });
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

function sitesInOrder(ctx: AggregateContext, subs: DigestSubmission[]): [string, DigestSubmission[]][] {
  return [...groupBy(subs, (s) => s.location_code ?? "")].sort((a, b) =>
    siteName(ctx, a[0] || null).localeCompare(siteName(ctx, b[0] || null))
  );
}

function easternDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

export function tableData(ctx: AggregateContext, subs: DigestSubmission[], t: DigestTable): TableData | null {
  if (t.kind === "none") return null;

  if (t.kind === "rows") {
    const fields = (t.fields ?? []).filter((k) => fieldByKey(ctx, k));
    const sections = sitesInOrder(ctx, subs).map(([code, list]) => ({
      title: siteName(ctx, code || null),
      rows: [...list]
        .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
        .map((s) => [easternDateTime(s.submitted_at), ...fields.map((k) => displayValue(ctx, k, s.payload[k]))])
    }));
    return { columns: ["Submitted", ...fields.map((k) => fieldLabel(ctx, k))], numericFrom: 99, sections };
  }

  const metrics = t.metrics?.length ? t.metrics : [{ agg: "count" as const }];
  const mCols = metrics.map((m) => metricLabel(ctx, m));
  const group = t.group ?? "site";
  const days = bucketsFor(ctx, subs, "day");
  const dayRows = (list: DigestSubmission[]) => {
    const byDay = groupBy(list, (s) => easternYmdOf(s.submitted_at));
    // Only days with submissions: a table of zero rows is noise (the chart shows the gaps).
    return days.filter((d) => byDay.has(d.key)).map((d) => [d.label, ...metricCells(byDay.get(d.key)!, metrics)]);
  };

  if (group === "day") {
    return {
      columns: ["Day", ...mCols],
      numericFrom: 1,
      sections: [{ rows: dayRows(subs) }],
      grandTotal: ["Total", ...metricCells(subs, metrics)]
    };
  }
  if (group === "site") {
    return {
      columns: ["Site", ...mCols],
      numericFrom: 1,
      sections: [{ rows: sitesInOrder(ctx, subs).map(([code, list]) => [siteName(ctx, code || null), ...metricCells(list, metrics)]) }],
      grandTotal: ["Total", ...metricCells(subs, metrics)]
    };
  }
  // site_day: a section per site, a row per day, a subtotal per site.
  const sites = sitesInOrder(ctx, subs);
  return {
    columns: ["Day", ...mCols],
    numericFrom: 1,
    sections: sites.map(([code, list]) => ({
      title: siteName(ctx, code || null),
      rows: dayRows(list),
      total: ["Site total", ...metricCells(list, metrics)]
    })),
    grandTotal: sites.length > 1 ? ["All sites", ...metricCells(subs, metrics)] : undefined
  };
}
