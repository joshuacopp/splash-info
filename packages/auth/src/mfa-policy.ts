// MFA ENROLLMENT POLICY — the org-wide countdown that forces every user onto
// a TOTP factor by a fixed deadline. This is a SEPARATE concern from mfa.ts
// (GoTrue factor operations) and from the MFA_ENFORCE step-up gate in
// session.ts:
//
//   • MFA_ENFORCE (session.ts)      — users who ALREADY HAVE a verified factor
//                                     must complete the aal2 step-up at login.
//   • MFA_ENROLL_ENFORCE (here)     — users who have NO verified factor must
//                                     ENROLL one before a deadline, or be
//                                     blocked from the dashboard.
//
// Pure, network-free date math so it's trivially unit-testable and identical
// across every worker. authenticate() calls resolveMfaEnrollment() to annotate
// the Session; nothing here performs I/O.
//
// POLICY (Josh, 2026-08-13):
//   • Flip day is 2026-08-14. Pre-existing accounts get a 14-day grace window
//     (deadline 2026-08-28). Everyone, all roles — no role carve-outs.
//   • Accounts created ON OR AFTER the flip day are "new" and must enroll on
//     first login — no grace. Their deadline is their own creation date, so
//     they are `overdue` the moment they first authenticate and get routed
//     straight to enrollment.
//   • Gated behind the MFA_ENROLL_ENFORCE env flag (per worker), mirroring
//     MFA_ENFORCE — when unset, resolveMfaEnrollment() returns undefined and
//     behavior is byte-for-byte identical to pre-policy.

import type { MfaEnrollmentStatus } from "@splash/types/session";
import type { AuthUser } from "@splash/types/auth";

/** Org-wide flip day (YYYY-MM-DD, UTC). The day the enrollment countdown
 *  begins for pre-existing accounts and the boundary that separates
 *  "pre-existing" from "new" accounts. */
export const MFA_ENROLL_POLICY_START = "2026-08-14";

/** Grace window, in days, granted to accounts that existed before the flip
 *  day. New accounts get none. */
export const MFA_ENROLL_GRACE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** MFA enrollment enforcement is opt-in per worker via MFA_ENROLL_ENFORCE,
 *  exactly like MFA_ENFORCE. Off by default. */
export function isMfaEnrollEnforced(env: { MFA_ENROLL_ENFORCE?: string }): boolean {
  return env.MFA_ENROLL_ENFORCE === "true" || env.MFA_ENROLL_ENFORCE === "1";
}

/** Parse a value to a UTC-midnight epoch (day granularity), dropping any
 *  time-of-day. Accepts "YYYY-MM-DD" and full ISO timestamps. Returns NaN on
 *  an unparseable value so callers can fail-open. */
function utcDayStart(value: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return NaN;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Format a UTC-midnight epoch back to a YYYY-MM-DD calendar string. */
function toIsoDate(epochDay: number): string {
  return new Date(epochDay).toISOString().slice(0, 10);
}

/**
 * Compute a user's enrollment countdown from pure inputs. Exported separately
 * from resolveMfaEnrollment so it can be unit-tested without an env/AuthUser.
 *
 *   - hasVerifiedFactor  → returns undefined (already enrolled, nothing to do).
 *   - new account        → deadline = creation day, overdue = true (enroll now).
 *   - pre-existing / unknown creation date → deadline = POLICY_START + grace.
 *
 * `now` is injectable for tests; production passes Date.now().
 */
export function computeMfaEnrollment(input: {
  createdAt?: string | null;
  hasVerifiedFactor: boolean;
  now?: number;
}): MfaEnrollmentStatus | undefined {
  if (input.hasVerifiedFactor) return undefined;

  const nowDay = utcDayStart(new Date(input.now ?? Date.now()).toISOString());
  const policyStartDay = utcDayStart(MFA_ENROLL_POLICY_START);

  const createdDay =
    input.createdAt != null ? utcDayStart(input.createdAt) : NaN;

  // A parseable creation date on/after the flip day marks a "new" account. A
  // missing or unparseable date fails open to the lenient pre-existing path so
  // a bad timestamp can never hard-lock someone out on first login.
  const isNewAccount = !Number.isNaN(createdDay) && createdDay >= policyStartDay;

  if (isNewAccount) {
    return {
      required: true,
      deadline: toIsoDate(createdDay),
      overdue: true,
      daysRemaining: 0
    };
  }

  const deadlineDay = policyStartDay + MFA_ENROLL_GRACE_DAYS * MS_PER_DAY;
  const daysRemaining = Math.round((deadlineDay - nowDay) / MS_PER_DAY);

  return {
    required: true,
    deadline: toIsoDate(deadlineDay),
    // Grace runs through the END of the deadline day; overdue only once the
    // calendar has advanced strictly past it.
    overdue: nowDay > deadlineDay,
    daysRemaining
  };
}

/**
 * Session-layer entry point. Returns undefined (→ no `mfaEnrollment` field on
 * the Session) when the policy flag is off or the user already has a verified
 * factor; otherwise the countdown status. Never throws, never does I/O.
 */
export function resolveMfaEnrollment(
  env: { MFA_ENROLL_ENFORCE?: string },
  user: Pick<AuthUser, "created_at">,
  hasVerifiedFactor: boolean,
  now?: number
): MfaEnrollmentStatus | undefined {
  if (!isMfaEnrollEnforced(env)) return undefined;
  return computeMfaEnrollment({
    createdAt: user.created_at,
    hasVerifiedFactor,
    now
  });
}
