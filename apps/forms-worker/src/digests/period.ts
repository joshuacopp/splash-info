// Digest periods and due times, in EASTERN wall-clock time.
//
// Every site is Eastern, and "yesterday" means the site's yesterday: a UTC
// day would cut each Eastern day at 7pm/8pm and put the evening's salt runs
// in the wrong row. All calendar math here is on YYYY-MM-DD strings (via UTC
// Date objects, which have no DST), and only the final query bounds are
// converted to UTC instants.

import type { DigestSchedule } from "@splash/forms-schema";

const EASTERN = "America/New_York";

export interface EasternNow {
  ymd: string;
  hour: number;
  minute: number;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  isoWeekday: number;
  day: number;
}

export function easternNow(at: Date = new Date()): EasternNow {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const hour = Number(parts.get("hour")) % 24; // some runtimes emit "24" at midnight
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.get("weekday") ?? "") + 1;
  return {
    ymd: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    hour,
    minute: Number(parts.get("minute")),
    isoWeekday: wd,
    day: Number(parts.get("day"))
  };
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date (1 = Monday). */
export function isoWeekdayOf(ymd: string): number {
  const wd = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** The UTC instant at which an Eastern calendar day begins. */
export function easternMidnightUtc(ymd: string): Date {
  // Guess with EST, then correct by the actual offset at that instant -- the
  // two can differ only on a DST-change day, and midnight is never inside the
  // 2am switch, so one correction is exact.
  const guess = new Date(`${ymd}T05:00:00Z`);
  const off = offsetMinutes(guess);
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - off * 60_000);
}

/** Eastern offset from UTC in minutes at an instant (-300 EST, -240 EDT). */
function offsetMinutes(at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return -300;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -mins : mins;
}

/** Eastern calendar day of an instant. */
export function easternYmdOf(iso: string): string {
  return easternNow(new Date(iso)).ymd;
}

export interface DigestPeriod {
  /** Stable key; the send lock is UNIQUE (digest_id, key). */
  key: string;
  /** Inclusive Eastern calendar days. */
  from: string;
  to: string;
  /** Query bounds: [fromUtc, toUtcExclusive). */
  fromUtc: string;
  toUtcExclusive: string;
  /** "Nov 10 - Nov 16, 2026" */
  label: string;
}

/** The period that just ended as of Eastern day `today`. */
export function periodFor(frequency: DigestSchedule["frequency"], today: string): DigestPeriod {
  let from: string;
  let to: string;
  let key: string;
  if (frequency === "daily") {
    from = to = addDays(today, -1);
    key = `D:${from}`;
  } else if (frequency === "weekly") {
    to = addDays(today, -1);
    from = addDays(to, -6);
    key = `W:${from}`;
  } else {
    const first = `${today.slice(0, 7)}-01`;
    to = addDays(first, -1);
    from = `${to.slice(0, 7)}-01`;
    key = `M:${from.slice(0, 7)}`;
  }
  return {
    key,
    from,
    to,
    fromUtc: easternMidnightUtc(from).toISOString(),
    toUtcExclusive: easternMidnightUtc(addDays(to, 1)).toISOString(),
    label: periodLabel(from, to)
  };
}

/**
 * For tests and previews: the same span as the real period but ENDING TODAY
 * (daily = today, weekly = the last 7 days including today, monthly = this
 * month so far), so a submission made a minute ago is included.
 */
export function periodThroughToday(frequency: DigestSchedule["frequency"], today: string): DigestPeriod {
  const to = today;
  const from = frequency === "daily" ? today : frequency === "weekly" ? addDays(today, -6) : `${today.slice(0, 7)}-01`;
  return {
    key: `P:${from}:${to}`,
    from,
    to,
    fromUtc: easternMidnightUtc(from).toISOString(),
    toUtcExclusive: easternMidnightUtc(addDays(to, 1)).toISOString(),
    label: `${periodLabel(from, to)} (through today)`
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(ymd: string): string {
  return `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
}

function periodLabel(from: string, to: string): string {
  if (from === to) return `${shortDate(from)}, ${from.slice(0, 4)}`;
  return `${shortDate(from)} - ${shortDate(to)}, ${to.slice(0, 4)}`;
}

/**
 * Is the digest due now, and for which period?
 *
 * Due once its send hour has arrived on its send day. "Arrived", not "is", so a
 * cron outage or a deploy across the hour still sends later the same day --
 * the run-row lock keeps that from ever sending twice. A whole missed day is
 * NOT caught up: a digest a day late is noise, and the next one covers it.
 */
export function duePeriod(schedule: DigestSchedule, now: EasternNow): DigestPeriod | null {
  if (now.hour < schedule.hour) return null;
  if (schedule.frequency === "weekly" && now.isoWeekday !== (schedule.weekday ?? 1)) return null;
  if (schedule.frequency === "monthly" && now.day !== (schedule.monthday ?? 1)) return null;
  return periodFor(schedule.frequency, now.ymd);
}
