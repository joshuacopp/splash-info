// Report time model: every report day is an America/New_York calendar day.
//
// Before this module, "today" meant Eastern in some reports and UTC in others,
// so after 7-8 PM ET a UTC report's "today" was already tomorrow and late
// activity landed on the wrong day. This is now the ONE implementation; new
// reports must not compute dates any other way.
//
// Ranges are inclusive calendar days ("from" 00:00 ET through the end of "to"
// in ET), carried as both YYYY-MM-DD (for URLs, labels, filenames) and UTC ISO
// instants (for queries against timestamptz columns).

export const REPORT_TIME_ZONE = "America/New_York";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymdToString(v: Ymd): string {
  return `${v.y}-${pad2(v.m)}-${pad2(v.d)}`;
}

/** Parse YYYY-MM-DD; null when malformed or not a real calendar date. */
export function parseYmd(s: string | null | undefined): Ymd | null {
  if (!s || !YMD_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map((p) => Number.parseInt(p, 10)) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Calendar arithmetic on a date with no time zone attached. */
export function addDays(v: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(v.y, v.m - 1, v.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The Eastern calendar date of an instant (default: now). */
export function easternYmd(at: Date = new Date()): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(at);
  const get = (t: string) => Number.parseInt(parts.find((p) => p.type === t)?.value ?? "", 10);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Eastern offset from UTC in minutes (-300 EST, -240 EDT) at an instant. */
function easternOffsetMinutes(at: Date): number {
  const tz = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    hour: "numeric",
    timeZoneName: "shortOffset"
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = tz?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return -300;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (Number.parseInt(m[2]!, 10) * 60 + (m[3] ? Number.parseInt(m[3], 10) : 0));
}

/**
 * UTC instant of Eastern midnight starting `v`.
 *
 * The offset must be read AT midnight, not later in the day: on a changeover
 * Sunday the switch happens at 2 AM, so a noon probe returns the NEW offset
 * and puts midnight an hour off (caught by the DST test). Two passes: guess
 * with the offset at UTC-5 midnight, then re-read the offset at the guess in
 * case the first probe straddled the change.
 */
export function easternStartOfDay(v: Ymd): Date {
  const utcMidnight = Date.UTC(v.y, v.m - 1, v.d);
  const first = easternOffsetMinutes(new Date(utcMidnight + 5 * 3_600_000));
  const guess = utcMidnight - first * 60_000;
  const second = easternOffsetMinutes(new Date(guess));
  return new Date(utcMidnight - second * 60_000);
}

export const RANGE_PRESETS = [
  "today",
  "yesterday",
  "last_7",
  "last_30",
  "mtd",
  "past_month",
  "qtd",
  "past_quarter",
  "ytd"
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7: "Last 7 days",
  last_30: "Last 30 days",
  mtd: "Month to date",
  past_month: "Last month",
  qtd: "Quarter to date",
  past_quarter: "Last quarter",
  ytd: "Year to date"
};

export function isRangePreset(s: unknown): s is RangePreset {
  return typeof s === "string" && (RANGE_PRESETS as readonly string[]).includes(s);
}

export interface ResolvedRange {
  /** The preset that produced this range, or "custom" for explicit from/to. */
  preset: RangePreset | "custom";
  fromYmd: string;
  toYmd: string;
  /** Inclusive lower bound, UTC ISO: 00:00 ET on fromYmd. */
  fromIso: string;
  /** Inclusive upper bound, UTC ISO: the last millisecond of toYmd in ET. */
  toIso: string;
  /** True when explicit input was malformed and the default was used instead. */
  invalidInput: boolean;
}

function presetBounds(p: RangePreset, today: Ymd): [Ymd, Ymd] {
  const q = Math.floor((today.m - 1) / 3); // 0-3
  switch (p) {
    case "today":
      return [today, today];
    case "yesterday": {
      const y = addDays(today, -1);
      return [y, y];
    }
    case "last_7":
      return [addDays(today, -6), today];
    case "last_30":
      return [addDays(today, -29), today];
    case "mtd":
      return [{ ...today, d: 1 }, today];
    case "past_month": {
      const firstThis = { ...today, d: 1 };
      const lastPrev = addDays(firstThis, -1);
      return [{ ...lastPrev, d: 1 }, lastPrev];
    }
    case "qtd":
      return [{ y: today.y, m: q * 3 + 1, d: 1 }, today];
    case "past_quarter": {
      const firstThisQ = { y: today.y, m: q * 3 + 1, d: 1 };
      const lastPrevQ = addDays(firstThisQ, -1);
      const pq = Math.floor((lastPrevQ.m - 1) / 3);
      return [{ y: lastPrevQ.y, m: pq * 3 + 1, d: 1 }, lastPrevQ];
    }
    case "ytd":
      return [{ y: today.y, m: 1, d: 1 }, today];
  }
}

function build(preset: RangePreset | "custom", from: Ymd, to: Ymd, invalidInput: boolean): ResolvedRange {
  return {
    preset,
    fromYmd: ymdToString(from),
    toYmd: ymdToString(to),
    fromIso: easternStartOfDay(from).toISOString(),
    toIso: new Date(easternStartOfDay(addDays(to, 1)).getTime() - 1).toISOString(),
    invalidInput
  };
}

export interface RangeInput {
  range?: string | null;
  from?: string | null;
  to?: string | null;
}

/**
 * Resolve URL input to a range. Precedence: a known `range` preset, then
 * explicit `from`/`to` (either may be omitted: a missing `from` takes the
 * default's start, a missing `to` is today), then the default preset.
 *
 * Malformed or reversed input FALLS BACK TO THE DEFAULT with `invalidInput`
 * set, rather than erroring: these URLs get bookmarked, and the page and the
 * worker must agree on what a bad URL means. Both call this function.
 */
export function resolveRange(
  input: RangeInput,
  defaultPreset: RangePreset,
  now: Date = new Date()
): ResolvedRange {
  const today = easternYmd(now);
  if (isRangePreset(input.range)) {
    const [f, t] = presetBounds(input.range, today);
    return build(input.range, f, t, false);
  }
  const hasFrom = !!input.from;
  const hasTo = !!input.to;
  if (hasFrom || hasTo) {
    const [defFrom] = presetBounds(defaultPreset, today);
    const from = hasFrom ? parseYmd(input.from) : defFrom;
    const to = hasTo ? parseYmd(input.to) : today;
    if (from && to && ymdToString(from) <= ymdToString(to)) {
      return build("custom", from, to, false);
    }
    const [f, t] = presetBounds(defaultPreset, today);
    return build(defaultPreset, f, t, true);
  }
  const [f, t] = presetBounds(defaultPreset, today);
  return build(defaultPreset, f, t, false);
}

/** "Oct 30, 2026, 7:25 PM" in Eastern. Returns the input on a bad date. */
export function formatEtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: REPORT_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

/** "Oct 30, 2026" for a YYYY-MM-DD (no zone shift) or an instant (in ET). */
export function formatEtDate(v: string | null | undefined): string {
  if (!v) return "";
  const ymd = parseYmd(v);
  const d = ymd ? new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12)) : new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", {
    timeZone: ymd ? "UTC" : REPORT_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

/** "5 min ago" / "3 days ago"; falls back to the absolute ET date after 30 days. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.max(sec, 0)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatEtDateTime(iso);
}

/** "Oct 1 – Oct 30, 2026" style label for a resolved range. */
export function formatRangeLabel(r: Pick<ResolvedRange, "fromYmd" | "toYmd">): string {
  if (r.fromYmd === r.toYmd) return formatEtDate(r.fromYmd);
  return `${formatEtDate(r.fromYmd)} – ${formatEtDate(r.toYmd)}`;
}
