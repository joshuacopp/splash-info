// Cell formatting shared by the greeter scorecard and its report view.
//
// Extracted from page.tsx when /admin/greeters/report was added. These are not
// generic helpers — every one of them encodes a decision about what a null
// means on this data set, and the two pages have to answer that question the
// same way or the same figure will read differently depending on which screen
// you're on.
//
// The recurring rule: NULL IS "UNKNOWN", NEVER ZERO. A greeter day with no wash
// sales has no capture rate to report; rendering it as 0% would put a real
// number next to a real goal and grade somebody against arithmetic that never
// happened. Every formatter here renders an em dash instead.

import type { ReactNode } from "react";

/** Plain count. */
export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/** Dollar amount, always two places — these are sales figures, not estimates. */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/** Null means "no denominator" — unknown, not zero. Say so with a dash. */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}%`;
}

/** D.O.B. — dollars per wash sale. Two places, like the goal it's graded on. */
export function dobCell(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(2)}`;
}

/** Hours worked / wash sales per hour. Two places; both are rates. */
export function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(2);
}

/**
 * Goals arrive AVGed out of the rollup and report functions, so a flat 30 can
 * come back as 30.000000000000001. Trim to two places and drop trailing zeros.
 */
export function goalNum(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** Goal shown beside the value it grades, e.g. "$4.20 / 5". */
export function goalSuffix(value: number | null | undefined): ReactNode {
  if (value === null || value === undefined) return null;
  return (
    <span className="text-xs font-normal text-splash-navy/50">
      {" "}
      / {goalNum(value)}
    </span>
  );
}

/**
 * Every Splash site is US Eastern. Hard-coded rather than read from the
 * request, because a business_date has to mean the same day to a manager in the
 * office and to the worker that stores it — deriving it from whoever happens to
 * be looking would make the same day render differently for a DC admin on a
 * laptop set to UTC.
 */
export const SITE_TIMEZONE = "America/New_York";

/**
 * Epoch millis -> "YYYY-MM-DD" in site local time.
 *
 * en-CA is the locale trick: its short date format IS ISO order, so this needs
 * no reassembly. Do NOT replace with toISOString().slice(0,10) — that's UTC and
 * rolls the date over at 8pm Eastern, which would make every window on the
 * report page start and end a day late for anyone looking after dinner.
 */
export function localDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

export const DAY_MS = 86_400_000;

/** "2026-08-11" -> "Tue 08-11". Parsed as UTC noon so the label can't slip. */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const dow = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short"
  }).format(d);
  return `${dow} ${iso.slice(5)}`;
}

/** First value of a Next.js searchParams entry, trimmed of the array wrapper. */
export function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
