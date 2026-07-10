// Shift validation — enforced BEFORE calling Beekeeper so the operator gets a
// clean error instead of a raw upstream rejection.
//
// Rules (from the handoff):
//   - No overlapping shifts for the same userId in the SAME schedule.
//     Non-overlapping same-day shifts are fine; overlaps across DIFFERENT
//     schedules are fine (only same-schedule overlaps are checked). Beekeeper
//     itself rejects same-schedule overlaps — we catch it first.
//   - title <= 80 chars.
//   - Valid ISO-8601 UTC on start / end.

import { MAX_TITLE_LEN } from "./time.js";
import type { BeekeeperShift } from "./beekeeper.js";

export interface ValidationError {
  field: "userId" | "title" | "start" | "end" | "overlap";
  message: string;
}

/** ISO-8601 UTC with a trailing Z. Accepts optional fractional seconds. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

export interface ProposedShift {
  /** Present on edits — excluded from the overlap comparison so a shift never
   *  conflicts with itself. Absent on creates. */
  id?: string;
  /** Empty/absent for an OPEN/UNASSIGNED shift. */
  userId?: string;
  start: string;
  end: string;
  title: string;
}

/** Half-open [start, end) overlap: A.start < B.end && B.start < A.end. Handles
 *  overnight shifts because both bounds are absolute UTC instants. */
function instantsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Validate a proposed create/edit against the existing shifts already in the
 * SAME schedule. `existing` should be the schedule's shifts for a window that
 * covers the proposed times (the caller fetches them).
 *
 * Returns [] when valid, else the list of problems.
 */
export function validateShift(
  proposed: ProposedShift,
  existing: BeekeeperShift[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  // userId is optional: an empty/absent userId is an OPEN/UNASSIGNED shift.
  if (!proposed.title || proposed.title.length === 0) {
    errors.push({ field: "title", message: "title is required" });
  } else if (proposed.title.length > MAX_TITLE_LEN) {
    errors.push({
      field: "title",
      message: `title must be <= ${MAX_TITLE_LEN} characters`
    });
  }
  if (!isIsoUtc(proposed.start)) {
    errors.push({ field: "start", message: "start must be ISO-8601 UTC (…Z)" });
  }
  if (!isIsoUtc(proposed.end)) {
    errors.push({ field: "end", message: "end must be ISO-8601 UTC (…Z)" });
  }

  // Only run overlap detection when the instants are well-formed.
  if (errors.some((e) => e.field === "start" || e.field === "end")) {
    return errors;
  }

  // Open/unassigned shifts don't belong to an employee, so per-employee overlap
  // doesn't apply — any number of open shifts may coexist in the same window.
  if (!proposed.userId) {
    return errors;
  }

  const pStart = Date.parse(proposed.start);
  const pEnd = Date.parse(proposed.end);

  for (const shift of existing) {
    if (shift.userId !== proposed.userId) continue;
    if (proposed.id && shift.id === proposed.id) continue; // ignore self on edit
    const sStart = Date.parse(shift.start);
    const sEnd = Date.parse(shift.end);
    if (!Number.isFinite(sStart) || !Number.isFinite(sEnd)) continue;
    if (instantsOverlap(pStart, pEnd, sStart, sEnd)) {
      errors.push({
        field: "overlap",
        message: `overlaps an existing shift for this employee (${shift.title || shift.id})`
      });
      break;
    }
  }

  return errors;
}
