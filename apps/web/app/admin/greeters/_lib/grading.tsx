// How capture % and scan % get graded, shared by /admin/greeters and its report.
//
// These thresholds are the operators' numbers, not design choices. They live in
// one file so the scorecard and the report can't grade the same figure
// differently — a site showing amber on one page and red on the other would
// destroy trust in both, and it's exactly the kind of drift that creeps in when
// two pages each keep their own copy of a constant.
//
// Don't move SCAN_TARGET_PCT or CAPTURE_NEAR_MISS_POINTS without asking.

import { goalNum, pct } from "./format";

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
