// How capture % and scan % get graded, shared by /admin/greeters and its report.
//
// These thresholds are the operators' numbers, not design choices. They live in
// one file so the scorecard and the report can't grade the same figure
// differently — a site showing amber on one page and red on the other would
// destroy trust in both, and it's exactly the kind of drift that creeps in when
// two pages each keep their own copy of a constant.
//
// Don't move SCAN_TARGET_PCT or CAPTURE_NEAR_MISS_POINTS without asking.

import { goalNum, money, pct } from "./format";

/* ------------------------------------------------------------
 * Capture % against goal
 * ------------------------------------------------------------ */

/**
 * How far under goal still counts as "close", in PERCENTAGE POINTS.
 *
 * Both numbers are already percentages, so this is a straight subtraction:
 * a 30% goal makes 27.0%–29.9% yellow, not 29.1% (which is what a relative
 * 3%-of-goal reading would give). Points is what the operators mean when they
 * say "three points off".
 */
export const CAPTURE_NEAR_MISS_POINTS = 3;

export type CaptureTier = "hit" | "near" | "miss";

/**
 * Same class vocabulary as AgePill in /admin/damage, so the lists read the same
 * way. Kept as full literal strings — Tailwind scans source text, so a built-up
 * `bg-${x}-100` would get purged from the bundle.
 */
export const CAPTURE_TIER_CLASSES: Record<CaptureTier, string> = {
  hit: "bg-splash-success/15 text-splash-success",
  near: "bg-yellow-100 text-yellow-900",
  miss: "bg-splash-deny/15 text-splash-deny"
};

export function captureTier(value: number, goal: number): CaptureTier {
  if (value >= goal) return "hit";
  if (value >= goal - CAPTURE_NEAR_MISS_POINTS) return "near";
  return "miss";
}

/**
 * How close to the D.O.B. goal still counts as "close", as a RATIO of goal.
 *
 * Deliberately not the capture band. CAPTURE_NEAR_MISS_POINTS is three
 * PERCENTAGE POINTS, and dollars have no points — subtracting 3 from a $4.00
 * goal would call $1.05 a near miss and make anything above a dollar
 * ungradeable. D.O.B. goals sit in single digits, so the band has to scale with
 * the goal: 5% under a $4.00 goal is $3.80, which is what "close" means here.
 */
export const DOB_NEAR_MISS_RATIO = 0.95;

export function dobTier(value: number, goal: number): CaptureTier {
  if (value >= goal) return "hit";
  if (goal > 0 && value >= goal * DOB_NEAR_MISS_RATIO) return "near";
  return "miss";
}

/**
 * Capture % graded against the goal snapshotted on that row.
 *
 * Ungraded when either side is null — a day with no wash sales AND no sign ups
 * has no capture rate to judge, and a site with no goal window covering that
 * date was never given a target. Both render plain rather than green, since "no
 * goal" is not the same as "met the goal".
 */
export function CaptureCell({
  value,
  goal
}: {
  value: number | null;
  goal: number | null;
}) {
  if (value === null || goal === null) {
    return (
      <span className="font-semibold text-splash-navy">
        {pct(value)}
        {goal === null ? null : (
          <span className="text-xs font-normal text-splash-navy/50">
            {" "}
            / {goalNum(goal)}
          </span>
        )}
      </span>
    );
  }
  const tier = captureTier(value, goal);
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${CAPTURE_TIER_CLASSES[tier]}`}
      title={
        tier === "hit"
          ? `At or above the ${goalNum(goal)}% goal.`
          : `${(goal - value).toFixed(1)} points under the ${goalNum(goal)}% goal.`
      }
    >
      {pct(value)}
      <span className="ml-1 font-normal opacity-70">/ {goalNum(goal)}</span>
    </span>
  );
}

export function CaptureLegend() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-splash-navy/60">
      <span className="font-semibold uppercase tracking-wider">Capture %</span>
      <span
        className={`rounded-full px-2 py-0.5 font-bold ${CAPTURE_TIER_CLASSES.hit}`}
      >
        At or above goal
      </span>
      <span
        className={`rounded-full px-2 py-0.5 font-bold ${CAPTURE_TIER_CLASSES.near}`}
      >
        Within {CAPTURE_NEAR_MISS_POINTS} points
      </span>
      <span
        className={`rounded-full px-2 py-0.5 font-bold ${CAPTURE_TIER_CLASSES.miss}`}
      >
        More than {CAPTURE_NEAR_MISS_POINTS} points under
      </span>
      <span>Graded against the goal in force on each row&rsquo;s date.</span>
    </div>
  );
}

/* ------------------------------------------------------------
 * Scan rate (attribution / data quality)
 * ------------------------------------------------------------ */

/**
 * At or above this, a site is considered to be attributing its cars properly.
 * This is the line the underreported watchlist uses, and it's the operators'
 * number — don't move it without asking.
 */
export const SCAN_TARGET_PCT = 90;

/**
 * Width of the amber band below the target, in percentage points. Purely
 * presentational: nothing is flagged on this number, it just stops an 88% and
 * a 40% from looking equally alarming in the table.
 */
export const SCAN_NEAR_MISS_POINTS = 10;

export function scanTier(value: number): CaptureTier {
  if (value >= SCAN_TARGET_PCT) return "hit";
  if (value >= SCAN_TARGET_PCT - SCAN_NEAR_MISS_POINTS) return "near";
  return "miss";
}

/* ------------------------------------------------------------
 * Labor and revenue trend % (month to date, site only)
 * ------------------------------------------------------------ */

/**
 * THE TWO COLUMNS THAT GRADE THE SAME ARITHMETIC IN OPPOSITE DIRECTIONS.
 *
 *   labor_trend_pct    over 100 is BAD  — projected to overspend the budget.
 *   revenue_trend_pct  over 100 is GOOD — projected to beat the goal.
 *
 * Both are trend dollars over target dollars times 100, both are generated in
 * Postgres, and the intuitive "over goal is green" rule paints exactly half of
 * them the wrong colour. A site trending at 112% of its labor budget would go
 * green and be congratulated on the Morning call for overspending by twelve
 * points, and it would look completely correct to anyone reviewing the code.
 *
 * That is why direction is a REQUIRED argument with no default rather than two
 * near-identical helpers or a boolean: a new call site cannot compile without
 * stating which way its number reads, and "under-is-good" / "over-is-good" says
 * it in words at the call site where the mistake would be made. Do not add a
 * default value here.
 */
export type TrendDirection = "under-is-good" | "over-is-good";

/** Both percentages are against a target of exactly the whole month's dollars. */
export const TREND_TARGET_PCT = 100;

/**
 * Width of the amber band on the WRONG side of 100, in percentage points.
 *
 * Presentational only — nothing is flagged or listed on this number, it just
 * stops a site one point over budget from looking as bad as one twenty points
 * over. Unlike SCAN_TARGET_PCT and CAPTURE_NEAR_MISS_POINTS, this is NOT yet an
 * operators' number: nobody has said how far off trend is "close". If Josh gives
 * one, it replaces this constant and both columns move together.
 */
export const TREND_NEAR_MISS_POINTS = 5;

export function trendTier(value: number, direction: TrendDirection): CaptureTier {
  if (direction === "under-is-good") {
    // OPEN QUESTION, deliberately left as a hit: a site trending far UNDER its
    // labor budget may be understaffed rather than efficient, and nobody has
    // decided whether that deserves its own colour. Grading it green is the
    // current answer, not a considered one. A third tier for "suspiciously far
    // under" goes here, as a floor beneath this branch — not by flipping the
    // comparison, which would mark every well-run site red.
    if (value <= TREND_TARGET_PCT) return "hit";
    if (value <= TREND_TARGET_PCT + TREND_NEAR_MISS_POINTS) return "near";
    return "miss";
  }
  if (value >= TREND_TARGET_PCT) return "hit";
  if (value >= TREND_TARGET_PCT - TREND_NEAR_MISS_POINTS) return "near";
  return "miss";
}

/**
 * A trend percentage with the two dollar figures it came from.
 *
 * The dollars are shown rather than tucked into the tooltip for the same reason
 * CaptureCell prints "/ 30" next to a capture rate: a percentage nobody can see
 * the inputs of is a number that gets argued with on the call. Same pill, same
 * tier classes, so the row reads as one table and not as two grading schemes.
 *
 * NULL RENDERS AS A DASH AND IS NEVER COLOURED. The percentage is null whenever
 * a target or a trend is missing, or the target is zero — a site whose month was
 * never configured, or a day nobody read a fresh number for. Both are normal.
 * Painting that green would claim a site hit a budget it was never given.
 */
export function TrendCell({
  value,
  actual,
  target,
  direction,
  label
}: {
  /** The generated percentage, straight off the row. Never recomputed here. */
  value: number | null;
  /** Trend dollars — the numerator. */
  actual: number | null;
  /** Budget or goal dollars — the denominator. */
  target: number | null;
  direction: TrendDirection;
  /** Names the denominator in the tooltip, e.g. "labor budget". */
  label: string;
}) {
  if (value === null) {
    // Three different silences, said differently, because "nobody set a budget"
    // and "nobody read today's number" are fixed by different people. The zero
    // case is real and legal — a site told to spend nothing on labor — and the
    // database returns null rather than dividing by it.
    const why =
      target === null
        ? `No ${label} set for this month, so there is no percentage to read.`
        : target === 0
          ? `The ${label} for this month is ${money(0)}, and there is no percentage of nothing.`
          : `${money(target)} ${label}, but no trending figure was reported.`;
    return (
      <span className="text-splash-navy/40" title={why}>
        —
      </span>
    );
  }

  const tier = trendTier(value, direction);
  const gap = value - TREND_TARGET_PCT;
  const title =
    direction === "under-is-good"
      ? gap <= 0
        ? `Trending ${Math.abs(gap).toFixed(1)} points under the ${label} — ${money(actual)} against ${money(target)}. Under 100% is good here.`
        : `Trending ${gap.toFixed(1)} points OVER the ${label} — ${money(actual)} against ${money(target)}. Over 100% is an overspend.`
      : gap >= 0
        ? `Trending ${gap.toFixed(1)} points over the ${label} — ${money(actual)} against ${money(target)}. Over 100% is good here.`
        : `Trending ${Math.abs(gap).toFixed(1)} points under the ${label} — ${money(actual)} against ${money(target)}.`;

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${CAPTURE_TIER_CLASSES[tier]}`}
      title={title}
    >
      {pct(value)}
      <span className="ml-1 font-normal opacity-70">
        {money(actual)} / {money(target)}
      </span>
    </span>
  );
}
