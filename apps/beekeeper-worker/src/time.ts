// Time model — Johnson City local (America/New_York) <-> UTC.
//
// The UI picks wall-clock times with four dropdowns (start H:M, end H:M) in
// ET. Beekeeper stores + returns UTC. We convert local->UTC on write and
// UTC->local on read using a REAL IANA zone via Intl — NEVER a hardcoded
// -04:00 offset, so DST is handled correctly (EDT vs EST).
//
// There are NO shift definitions here: the API only ever sees start / end /
// title. `title` is app-owned and auto-generated from the picked times (with
// an override path for non-time labels like "PTO").

export const SCHEDULE_TZ = "America/New_York";

/* ============================================================
 * Zone offset primitive
 * ============================================================ */

/**
 * Offset (ms) of `timeZone` at the given UTC instant, defined so that
 *   wallClockMillis = utcMillis + offset
 * e.g. EDT (UTC-4) => -14_400_000. Computed by formatting the instant in the
 * zone and diffing against the same wall-clock reinterpreted as UTC.
 */
function zoneOffsetMs(timeZone: string, utcMillis: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(new Date(utcMillis));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  // Intl renders 24:00 as hour "24" at midnight in some engines — normalize.
  // These parts are always present for the fixed options above; the `!`s
  // satisfy noUncheckedIndexedAccess on the Record index signature.
  const hour = map.hour === 24 ? 0 : map.hour!;
  const asUtc = Date.UTC(
    map.year!,
    map.month! - 1,
    map.day!,
    hour,
    map.minute!,
    map.second!
  );
  return asUtc - utcMillis;
}

/* ============================================================
 * Local (ET wall clock) -> UTC
 * ============================================================ */

/**
 * Convert an ET wall-clock date+time to a UTC ISO-8601 string (…Z).
 *
 * `dateStr` is a local calendar date "YYYY-MM-DD" in ET. Because the offset
 * itself depends on the instant (DST), we make an initial UTC guess, read the
 * zone offset there, correct, then re-check once to settle DST-boundary cases.
 */
export function localToUtcIso(
  dateStr: string,
  hour: number,
  minute: number
): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`Invalid date "${dateStr}" (expected YYYY-MM-DD)`);
  }
  const wallAsUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  let offset = zoneOffsetMs(SCHEDULE_TZ, wallAsUtc);
  let utc = wallAsUtc - offset;
  const offset2 = zoneOffsetMs(SCHEDULE_TZ, utc);
  if (offset2 !== offset) {
    offset = offset2;
    utc = wallAsUtc - offset;
  }
  return new Date(utc).toISOString().replace(/\.000Z$/, "Z");
}

/** Add N calendar days to a "YYYY-MM-DD" string (UTC-safe arithmetic). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export interface ShiftTimesInput {
  /** Local ET calendar date of the shift's START, "YYYY-MM-DD". */
  date: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export interface ShiftTimesUtc {
  start: string;
  end: string;
  /** True when the shift crossed midnight (end rolled to the next day). */
  overnight: boolean;
}

/**
 * Build UTC start/end from the four ET dropdown values.
 *
 * Overnight: if end <= start (same-day minutes-of-day), the shift ends the
 * NEXT day — we roll the end date forward one local day before converting, so
 * the emitted UTC `end` is correct across the DST boundary too. No special
 * flag is sent to Beekeeper; the next-day UTC end is self-describing.
 */
export function buildShiftTimes(input: ShiftTimesInput): ShiftTimesUtc {
  const startMinutes = input.startHour * 60 + input.startMinute;
  const endMinutes = input.endHour * 60 + input.endMinute;
  const overnight = endMinutes <= startMinutes;
  const endDate = overnight ? addDays(input.date, 1) : input.date;
  return {
    start: localToUtcIso(input.date, input.startHour, input.startMinute),
    end: localToUtcIso(endDate, input.endHour, input.endMinute),
    overnight
  };
}

/* ============================================================
 * UTC -> Local (ET) for reads
 * ============================================================ */

export interface LocalParts {
  /** ET calendar date "YYYY-MM-DD". */
  date: string;
  hour: number;
  minute: number;
}

/** Break a UTC ISO string into ET calendar/clock parts for display + editing. */
export function utcIsoToLocalParts(iso: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(iso))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute: Number(map.minute)
  };
}

/* ============================================================
 * Title generation
 * ============================================================ */

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 24h -> 12h clock label with no am/pm; minutes dropped when :00.
 *  17:00 -> "5", 7:30 -> "7:30", 0:15 -> "12:15". */
export function clockLabel(hour24: number, minute: number): string {
  const h12 = ((hour24 + 11) % 12) + 1;
  return minute === 0 ? String(h12) : `${h12}:${pad2(minute)}`;
}

export const MAX_TITLE_LEN = 80;

/**
 * Auto-generate the human shift label from the picked times, e.g.
 * 7:30 AM–5:00 PM -> "7:30-5"; 6 PM–2 AM -> "6-2"; 2:30 PM–8:30 PM -> "2:30-8:30".
 * Mirrors how the dashboard grid reads. Capped at 80 chars.
 */
export function generateTitle(
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number
): string {
  const label = `${clockLabel(startHour, startMinute)}-${clockLabel(endHour, endMinute)}`;
  return label.slice(0, MAX_TITLE_LEN);
}
