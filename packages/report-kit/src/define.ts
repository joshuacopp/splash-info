// Report definitions. A report is declared once and imported by BOTH the
// worker (to run the query and write exports) and the apps/web page (to render
// the filter bar and table), so the two cannot disagree about columns,
// defaults or what a URL means.
//
// Plain TS, no React: this file is bundled into Workers.

import {
  addDays,
  easternYmd,
  formatEtDate,
  formatEtDateTime,
  resolveRange,
  ymdToString,
  type RangePreset,
  type ResolvedRange
} from "./time";

export type ColumnKind =
  | "text"
  | "number"
  /** Dollars as a number. */
  | "currency"
  /** Integer cents (the MaintainX convention); rendered as dollars. */
  | "cents"
  /** A fraction (0.25 = 25%). */
  | "percent"
  /** YYYY-MM-DD calendar date. */
  | "date"
  /** An instant; displayed in Eastern, exported as UTC ISO. */
  | "datetime"
  | "email"
  | "phone"
  | "enum"
  | "boolean"
  /** Structured value; exported as JSON text, not shown in tables by default. */
  | "json";

export interface ReportColumn<Row> {
  /** Stable id. Also the CSV header unless `csvLabel` is set. */
  id: string;
  /** Header shown in the table. */
  label: string;
  kind: ColumnKind;
  /** Value accessor; defaults to `row[id]`. */
  get?: (row: Row) => unknown;
  /** Where the column appears. Default: both. */
  in?: ReadonlyArray<"table" | "export">;
  /** Export header override (default: `id`, which keeps CSV headers machine-stable). */
  csvLabel?: string;
}

export interface ReportFilter {
  id: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export interface ReportDef<Row> {
  id: string;
  title: string;
  /** Default range when the URL names none. */
  defaultRange: RangePreset;
  /** Presets offered as chips. Custom from/to is always available. */
  presets: ReadonlyArray<RangePreset>;
  filters: ReadonlyArray<ReportFilter>;
  columns: ReadonlyArray<ReportColumn<Row>>;
  /** Stable row key for the table. */
  rowKey: (row: Row) => string;
  /**
   * Pre-kit `?days=N` values to keep honouring for old bookmarks. `days=N`
   * means "N days ago through today" (N+1 Eastern days, as the old code had
   * it) and only applies when the URL carries no `range`/`from`/`to`.
   */
  legacyDays?: ReadonlyArray<number>;
}

export function defineReport<Row>(def: ReportDef<Row>): ReportDef<Row> {
  const seen = new Set<string>();
  for (const c of def.columns) {
    if (seen.has(c.id)) throw new Error(`report ${def.id}: duplicate column id "${c.id}"`);
    seen.add(c.id);
  }
  return def;
}

export function columnValue<Row>(col: ReportColumn<Row>, row: Row): unknown {
  return col.get ? col.get(row) : (row as Record<string, unknown>)[col.id];
}

export function columnsFor<Row>(
  def: ReportDef<Row>,
  where: "table" | "export"
): ReportColumn<Row>[] {
  return def.columns.filter((c) => (c.in ?? ["table", "export"]).includes(where));
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : raw;
}

/** Human display text for a cell ("" for empty). Tables and PDFs use this. */
export function formatCell<Row>(col: ReportColumn<Row>, row: Row): string {
  const v = columnValue(col, row);
  if (v == null || v === "") return "";
  switch (col.kind) {
    case "number":
      return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
    case "currency":
      return typeof v === "number" ? USD.format(v) : String(v);
    case "cents":
      return typeof v === "number" ? USD.format(v / 100) : String(v);
    case "percent":
      return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : String(v);
    case "date":
      return formatEtDate(String(v));
    case "datetime":
      return formatEtDateTime(String(v));
    case "phone":
      return formatPhone(String(v));
    case "boolean":
      return v ? "Yes" : "No";
    case "json":
      return JSON.stringify(v);
    default:
      return String(v);
  }
}

/** Raw-ish export value: numbers stay numbers, instants stay UTC ISO. */
export function exportCell<Row>(col: ReportColumn<Row>, row: Row): string | number | boolean | null {
  const v = columnValue(col, row);
  if (v == null) return null;
  if (col.kind === "json") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/** Comparable value for sorting. */
export function sortValue<Row>(col: ReportColumn<Row>, row: Row): string | number {
  const v = columnValue(col, row);
  if (v == null) return "";
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return String(v).toLowerCase();
}

export type SearchParamsLike =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function readParam(sp: SearchParamsLike, key: string): string | null {
  if (sp instanceof URLSearchParams) return sp.get(key);
  const v = sp[key];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export interface ReportParams {
  range: ResolvedRange;
  /** Declared filters that carry a valid option value. Unknown values dropped. */
  filters: Record<string, string>;
}

/**
 * The one URL parser for a report. URL keys: `range` (preset), `from`, `to`,
 * and each declared filter id. Unknown keys are ignored; an option value the
 * report doesn't declare is dropped rather than passed to a query.
 */
export function parseReportParams<Row>(
  def: ReportDef<Row>,
  sp: SearchParamsLike,
  now: Date = new Date()
): ReportParams {
  let from = readParam(sp, "from");
  let to = readParam(sp, "to");
  const preset = readParam(sp, "range");
  const days = Number(readParam(sp, "days"));
  if (!preset && !from && !to && def.legacyDays?.includes(days)) {
    const today = easternYmd(now);
    from = ymdToString(addDays(today, -days));
    to = ymdToString(today);
  }
  const range = resolveRange({ range: preset, from, to }, def.defaultRange, now);
  const filters: Record<string, string> = {};
  for (const f of def.filters) {
    const v = readParam(sp, f.id);
    if (v && f.options.some((o) => o.value === v)) filters[f.id] = v;
  }
  return { range, filters };
}

/** `{report-id}-{from}-to-{to}.{ext}`, Eastern dates. */
export function exportFilename<Row>(def: ReportDef<Row>, range: ResolvedRange, ext: "csv" | "xlsx"): string {
  return `${def.id}-${range.fromYmd}-to-${range.toYmd}.${ext}`;
}
