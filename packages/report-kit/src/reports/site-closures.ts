// Site closures (site_closures, supabase/site-status-01.sql). The board at
// /admin/site-status shows what is closed now; this is the history: how often
// each site closes, for how long, why, and how good the estimates were.
//
// A closure still open is counted up to "now" (its hours keep growing until it
// reopens). Rows are bucketed by when the closure STARTED, in Eastern time.
//
// Pure TS: the page aggregates and renders, the CSV route exports, both from
// the same rows the worker returns.

import { defineReport } from "../define";
import { addDays, easternYmd, formatEtDateTime, ymdToString } from "../time";

export const SITE_CLOSURE_REASON_LABEL: Record<string, string> = {
  weather: "Weather",
  power: "Power outage",
  water: "Water / plumbing",
  equipment: "Equipment failure",
  staffing: "Staffing",
  other: "Other"
};

/** As the worker returns it (a site_closures row). */
export interface SiteClosureRecord {
  id: string;
  site_number: number;
  site_name: string;
  rd_name: string | null;
  rm_name: string | null;
  reason: string;
  reason_detail: string | null;
  closed_at: string;
  closed_by: string;
  original_est_reopen_at: string;
  est_reopen_at: string;
  estimate_changes: unknown[];
  reopened_at: string | null;
  reopened_by: string | null;
  reopened_via: string | null;
  /** Typed by whoever reopened it (board, site link or emailed link). */
  reopen_note?: string | null;
}

/** One closure with its durations worked out. Hours, one decimal. */
export interface SiteClosureRow extends SiteClosureRecord {
  still_closed: boolean;
  hours_closed: number;
  hours_estimated: number;
  /** Actual minus the FIRST estimate; positive = took longer than said. */
  hours_over_estimate: number;
  estimate_change_count: number;
  /** Every estimate change that carried a note, oldest first, one line each. */
  estimate_notes: string;
  reason_label: string;
}

interface EstimateChangeLike {
  at?: unknown;
  by?: unknown;
  to?: unknown;
  note?: unknown;
}

/** One line per noted change: "Nov 14, 2026, 3:05 PM - pat@x (new estimate Nov 14, 2026, 6:00 PM): parts late". */
export function estimateNotesText(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  return changes
    .filter((c): c is EstimateChangeLike => !!c && typeof c === "object")
    .filter((c) => typeof c.note === "string" && c.note.trim() !== "")
    .map((c) => {
      const when = typeof c.at === "string" ? formatEtDateTime(c.at) : "";
      const by = typeof c.by === "string" ? c.by : "";
      const to = typeof c.to === "string" ? ` (new estimate ${formatEtDateTime(c.to)})` : "";
      return `${[when, by].filter(Boolean).join(" - ")}${to}: ${String(c.note).trim()}`;
    })
    .join("\n");
}

const H = 3600000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function toClosureRows(records: ReadonlyArray<SiteClosureRecord>, now: Date = new Date()): SiteClosureRow[] {
  return records.map((r) => {
    const start = new Date(r.closed_at).getTime();
    const end = r.reopened_at ? new Date(r.reopened_at).getTime() : now.getTime();
    const est = new Date(r.original_est_reopen_at).getTime();
    return {
      ...r,
      still_closed: !r.reopened_at,
      hours_closed: round1((end - start) / H),
      hours_estimated: round1((est - start) / H),
      hours_over_estimate: round1((end - est) / H),
      estimate_change_count: Array.isArray(r.estimate_changes) ? r.estimate_changes.length : 0,
      estimate_notes: estimateNotesText(r.estimate_changes),
      reopen_note: r.reopen_note ?? null,
      reason_label: SITE_CLOSURE_REASON_LABEL[r.reason] ?? r.reason
    };
  });
}

export const siteClosuresReport = defineReport<SiteClosureRow>({
  id: "site-closures",
  title: "Site Closures",
  defaultRange: "last_30",
  presets: ["last_7", "last_30", "mtd", "past_month", "qtd", "ytd"],
  filters: [],
  rowKey: (r) => r.id,
  columns: [
    { id: "closed_at", label: "Closed", kind: "datetime" },
    { id: "site_number", label: "Site #", kind: "number" },
    { id: "site_name", label: "Site", kind: "text" },
    { id: "rd_name", label: "RD", kind: "text" },
    { id: "rm_name", label: "RM", kind: "text" },
    { id: "reason_label", label: "Reason", kind: "text", csvLabel: "reason" },
    { id: "reason_detail", label: "Details", kind: "text" },
    { id: "closed_by", label: "Closed by", kind: "email" },
    { id: "original_est_reopen_at", label: "First estimate", kind: "datetime", in: ["export"] },
    { id: "est_reopen_at", label: "Final estimate", kind: "datetime", in: ["export"] },
    { id: "reopened_at", label: "Reopened", kind: "datetime" },
    { id: "reopened_by", label: "Reopened by", kind: "text", in: ["export"] },
    { id: "reopened_via", label: "Reopened via", kind: "text", in: ["export"] },
    { id: "reopen_note", label: "Reopen note", kind: "text" },
    { id: "hours_closed", label: "Hours closed", kind: "number" },
    { id: "hours_estimated", label: "Hours estimated", kind: "number" },
    { id: "hours_over_estimate", label: "Over estimate (hrs)", kind: "number" },
    { id: "estimate_change_count", label: "Estimate changes", kind: "number", in: ["export"] },
    { id: "estimate_notes", label: "Estimate notes", kind: "text" },
    { id: "still_closed", label: "Still closed", kind: "boolean" }
  ]
});

// ---- aggregation ------------------------------------------------------------------

export interface ClosureGroup {
  key: string;
  label: string;
  /** Extra context, e.g. RD / RM for a site row. */
  sub?: string;
  closures: number;
  hours: number;
  avg_hours: number;
  longest_hours: number;
  /** Closures that ran past their first estimate. */
  over_estimate: number;
  top_reason: string;
  /** Count per reason key. */
  by_reason: Record<string, number>;
  last_closed_at: string;
}

function group(rows: ReadonlyArray<SiteClosureRow>, keyOf: (r: SiteClosureRow) => [string, string, string?]): ClosureGroup[] {
  const map = new Map<string, ClosureGroup>();
  for (const r of rows) {
    const [key, label, sub] = keyOf(r);
    let g = map.get(key);
    if (!g) {
      g = { key, label, sub, closures: 0, hours: 0, avg_hours: 0, longest_hours: 0, over_estimate: 0, top_reason: "", by_reason: {}, last_closed_at: r.closed_at };
      map.set(key, g);
    }
    g.closures++;
    g.hours += r.hours_closed;
    g.longest_hours = Math.max(g.longest_hours, r.hours_closed);
    if (r.hours_over_estimate > 0) g.over_estimate++;
    g.by_reason[r.reason] = (g.by_reason[r.reason] ?? 0) + 1;
    if (r.closed_at > g.last_closed_at) g.last_closed_at = r.closed_at;
  }
  for (const g of map.values()) {
    g.hours = round1(g.hours);
    g.avg_hours = round1(g.hours / g.closures);
    const top = Object.entries(g.by_reason).sort((a, b) => b[1] - a[1])[0];
    g.top_reason = top ? SITE_CLOSURE_REASON_LABEL[top[0]] ?? top[0] : "";
  }
  return [...map.values()].sort((a, b) => b.closures - a.closures || b.hours - a.hours || a.label.localeCompare(b.label));
}

export interface SiteClosureSummary {
  kpis: {
    closures: number;
    sites: number;
    hours: number;
    avg_hours: number;
    still_closed: number;
    /** Fraction (0..1) of FINISHED closures that ran past their first estimate. */
    over_estimate_rate: number | null;
  };
  by_site: ClosureGroup[];
  by_reason: ClosureGroup[];
  by_rd: ClosureGroup[];
  by_rm: ClosureGroup[];
  /** Monday-start Eastern weeks, oldest first, every week in range present. */
  by_week: Array<{ week: string; label: string; closures: number; hours: number; by_reason: Record<string, number> }>;
  longest: SiteClosureRow[];
}

function mondayOf(ymdStr: string): string {
  const [y, m, d] = ymdStr.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
  return ymdToString(addDays({ y, m, d }, -((dow + 6) % 7)));
}

export function summarizeClosures(rows: ReadonlyArray<SiteClosureRow>, range: { fromYmd: string; toYmd: string }): SiteClosureSummary {
  const finished = rows.filter((r) => !r.still_closed);
  const hours = round1(rows.reduce((s, r) => s + r.hours_closed, 0));

  const weeks = new Map<string, SiteClosureSummary["by_week"][number]>();
  // Every week in range, so quiet weeks show as zero instead of vanishing.
  let cursor = mondayOf(range.fromYmd);
  for (let i = 0; i < 60 && cursor <= range.toYmd; i++) {
    const [y, m, d] = cursor.split("-").map(Number) as [number, number, number];
    weeks.set(cursor, { week: cursor, label: `${m}/${d}`, closures: 0, hours: 0, by_reason: {} });
    cursor = ymdToString(addDays({ y, m, d }, 7));
  }
  for (const r of rows) {
    const wk = mondayOf(ymdToString(easternYmd(new Date(r.closed_at))));
    const w = weeks.get(wk) ?? { week: wk, label: `${Number(wk.slice(5, 7))}/${Number(wk.slice(8, 10))}`, closures: 0, hours: 0, by_reason: {} };
    w.closures++;
    w.hours = round1(w.hours + r.hours_closed);
    w.by_reason[r.reason] = (w.by_reason[r.reason] ?? 0) + 1;
    weeks.set(wk, w);
  }

  return {
    kpis: {
      closures: rows.length,
      sites: new Set(rows.map((r) => r.site_number)).size,
      hours,
      avg_hours: rows.length ? round1(hours / rows.length) : 0,
      still_closed: rows.length - finished.length,
      over_estimate_rate: finished.length ? finished.filter((r) => r.hours_over_estimate > 0).length / finished.length : null
    },
    by_site: group(rows, (r) => [String(r.site_number), `${r.site_name} (${r.site_number})`, [r.rd_name, r.rm_name].filter(Boolean).join(" / ")]),
    by_reason: group(rows, (r) => [r.reason, r.reason_label]),
    by_rd: group(rows, (r) => [r.rd_name ?? "-", r.rd_name ?? "No RD"]),
    by_rm: group(rows, (r) => [r.rm_name ?? "-", r.rm_name ?? "No RM"]),
    by_week: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    longest: [...rows].sort((a, b) => b.hours_closed - a.hours_closed).slice(0, 10)
  };
}
