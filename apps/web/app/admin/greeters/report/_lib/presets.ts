// The four quick-filter buttons, and the date arithmetic behind them.
//
// A preset is a WINDOW plus a THRESHOLD, nothing more. Both report endpoints
// return every row in the window ungraded by any cut-off, so "top performers"
// and "previous 7 days" are the same query with a different range and a filter
// applied in the page. That's why adding a fifth button costs no migration and
// no endpoint — and why the counts across views always reconcile.

export type ViewKey = "recent" | "top" | "under" | "morning";

export interface Preset {
  key: ViewKey;
  label: string;
  /** Length of the default window in days, inclusive of both ends. */
  days: number;
  /** Which table the view drives. */
  kind: "greeter" | "site";
  blurb: string;
}

/**
 * "More than 75% of graded days over goal" and "more than 50% under" are Josh's
 * numbers, stated that way — strictly greater than, so a greeter sitting exactly
 * on the line isn't swept into either list.
 */
export const TOP_PCT_OVER = 75;
export const UNDER_PCT_UNDER = 50;

/**
 * Copy only. The `low_sample` flag is computed in Postgres by
 * greeter_period_report(); the page reads the column and never recomputes it,
 * so this constant exists purely so the explanatory text can't drift from the
 * SQL. If the threshold moves, it moves in greeter-reactivations-07.sql first
 * (and in the inlined copy in greeter-scorecard-tables.sql), then here.
 *
 * 3 means "two or fewer graded days is a thin sample" — Josh's call. It was 5,
 * which flagged an ordinary four-day part-time week as too little to judge.
 */
export const LOW_SAMPLE_DAYS = 3;

export const PRESETS: Record<ViewKey, Preset> = {
  recent: {
    key: "recent",
    label: "Previous 7 days",
    days: 7,
    kind: "greeter",
    blurb:
      "Every greeter who logged a shift in the last seven days: D.O.B. for the period, days over and under the capture goal, and total sign ups."
  },
  under: {
    key: "under",
    label: "Underperformers",
    days: 60,
    kind: "greeter",
    blurb: `Sixty days. Greeters who finished under the capture goal on more than ${UNDER_PCT_UNDER}% of their graded days.`
  },
  top: {
    key: "top",
    label: "Top performers",
    days: 60,
    kind: "greeter",
    blurb: `Sixty days. Greeters who beat the capture goal on more than ${TOP_PCT_OVER}% of their graded days.`
  },
  morning: {
    key: "morning",
    label: "Morning call",
    days: 7,
    kind: "site",
    blurb:
      "Site numbers only, last seven days, worst capture first, every site already opened to its individual days. This view is the table and nothing else — no cards, no charts — because it gets read aloud off a phone."
  }
};

export const VIEW_ORDER: ViewKey[] = ["recent", "under", "top", "morning"];

export function normalizeView(raw: string): ViewKey {
  return (VIEW_ORDER as string[]).includes(raw) ? (raw as ViewKey) : "recent";
}

/* ------------------------------------------------------------
 * Date arithmetic
 * ------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/**
 * Shift an ISO date by whole days.
 *
 * Anchored at UTC NOON, not midnight. Midnight-anchored date math lands within
 * an hour of a DST boundary twice a year and silently returns the wrong day;
 * noon has twelve hours of slack in both directions, so this is exact for any
 * offset a US timezone will ever have.
 */
export function isoAdd(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T12:00:00Z`);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive length of a window, in days. */
export function isoSpan(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.round((b - a) / DAY_MS) + 1;
}

/**
 * The equal-length window immediately before this one, for the KPI deltas.
 *
 * Equal length and immediately adjacent so the comparison is like-for-like: a
 * seven-day window is compared against the seven days before it, which contain
 * the same mix of weekdays and weekend days. Comparing against "last month"
 * would make every Monday-to-Sunday report look seasonal.
 */
export function priorWindow(
  from: string,
  to: string
): { date_from: string; date_to: string } {
  const span = isoSpan(from, to);
  const priorTo = isoAdd(from, -1);
  return { date_from: isoAdd(priorTo, -(span - 1)), date_to: priorTo };
}

/** Accepts only YYYY-MM-DD, matching the worker's own parse. */
export function isoOrEmpty(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}
