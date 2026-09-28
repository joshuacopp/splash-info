// Who still counts as employed at a site — ONE COPY, for every picker.
//
// ===========================================================================
// WHY THIS IS A SHARED MODULE AND MUST STAY ONE
// ===========================================================================
// This rule used to live only in apps/beekeeper-worker/src/db.ts. The greeter
// scorecard's roster (getGreeterRoster in ./greeter.ts) is a package and cannot
// import from an app, so it shipped as a copy of that query WITHOUT the filter
// — same org-unit containment, same union of the schedule's user_ids, no
// eligibility check and not even the three columns needed to make one.
//
// MEASURED 2026-09-28, before the fix: across 7 mapped sites the greeter picker
// offered 172 people where the scheduler offered 135. Johnson City offered 26
// names against the scheduler's 12 — more than half of that dropdown had left
// the company. Managers were logging greeter days against departed staff.
//
// Two authority rules over one question drift, and the drift is silent: both
// lists look plausible, and nothing errors. So when a THIRD surface needs to
// ask "is this person still here", import this — do not copy it.
//
// ===========================================================================
// WHAT THE SIGNALS ARE ACTUALLY WORTH IN THIS TENANT
// ===========================================================================
// Three independent signals, any one of which disqualifies, because none is
// individually trustworthy. MEASURED against the live table 2026-09-28
// (1,970 rows):
//
//   suspended          0 rows true. Beekeeper-native and set by the platform,
//                      so in principle the most reliable -- but VERIFIED
//                      2026-08-23 against the live tenant, GET /users EXCLUDES
//                      suspended users entirely rather than flagging them. A
//                      suspended user does not come back marked, they stop
//                      coming back at all. The sync can therefore never observe
//                      `true`. Only `true` disqualifies.
//   employment_status  Only "Active" (1,853) or blank (117) exist -- nobody in
//                      the tenant maintains it. Only a non-empty value that is
//                      not "Active" disqualifies; blank means "nobody filled it
//                      in" and must not silently delete a real employee.
//   synced_at          THE ONLY ONE THAT FIRES, and the reason the other two
//                      are not enough. Falling out of the listing IS the
//                      signal. The upsert-only sync leaves a departed person's
//                      row frozen with stale org_unit_ids, so they keep
//                      matching the location query forever; their synced_at is
//                      what gives them away.
//
// The first two are kept anyway: they cost nothing, they would catch a
// departure same-day rather than after ROSTER_STALE_DAYS, and if Beekeeper ever
// starts including deactivated users in the listing (or the tenant starts
// maintaining employmentStatus) they begin working on their own.

/** The columns an eligibility decision needs. Every query feeding
 *  `isRosterEligible` must select these, or the filter reads three undefineds
 *  and silently passes everyone — which is exactly how the greeter picker came
 *  to show departed staff. Append to the caller's own select list. */
export const ROSTER_ELIGIBILITY_COLUMNS = "suspended,employment_status,synced_at";

/** The subset of a beekeeper_users row this rule reads. Callers pass their own
 *  wider row types structurally. */
export interface RosterEligibilityRow {
  suspended?: boolean | null;
  employment_status?: string | null;
  synced_at?: string | null;
}

/**
 * How far BEHIND THE MOST RECENT SYNC a user's row may fall before the person
 * is treated as gone. The sync runs daily, so 2 means a user has to be absent
 * from two consecutive tenant listings — enough to ride out one transient
 * pagination hiccup (listAllUsers stops on the first short page, so a Beekeeper
 * paging glitch under-fetches rather than erroring), short enough that a
 * manager isn't scheduling a ghost for a week.
 *
 * Measured against the newest row rather than the wall clock ON PURPOSE. If the
 * cutoff were `now - 2 days`, a sync that stopped running — expired token,
 * broken cron, Beekeeper outage — would age every row past it simultaneously
 * and empty the assignable roster at every location in the company. Comparing
 * rows to each other makes that failure inert: if nothing is syncing, nothing
 * is fresh, the newest row ages in lockstep with the rest, and nobody is
 * dropped. The filter only bites when the sync is demonstrably alive and has
 * chosen not to return someone.
 */
export const ROSTER_STALE_DAYS = 2;

/**
 * Whether a cached user still counts as employed here.
 *
 * This matters beyond a tidy dropdown. On the scheduler the grid derives the
 * salaried payroll baseline from the ROSTER, so a departed GM left in the list
 * keeps adding rate x 40 to the week total forever — a wrong number on a screen
 * whose entire job is to be a correct number. On the greeter scorecard a
 * departed name in the dropdown invites a day logged against someone who was
 * not there.
 *
 * A null synced_at passes: rows predate the column and must not vanish before
 * the first sync writes it.
 *
 * `latestSyncMs` is the newest synced_at among the rows being considered — see
 * ROSTER_STALE_DAYS for why the comparison is row-relative and not wall-clock.
 * Pass null to skip the staleness leg entirely.
 */
export function isRosterEligible(
  row: RosterEligibilityRow,
  latestSyncMs: number | null
): boolean {
  if (row.suspended === true) return false;
  const status = (row.employment_status ?? "").trim().toLowerCase();
  if (status && status !== "active") return false;
  if (latestSyncMs !== null && row.synced_at) {
    const seen = Date.parse(row.synced_at);
    if (
      Number.isFinite(seen) &&
      latestSyncMs - seen > ROSTER_STALE_DAYS * 86_400_000
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Newest synced_at across a set of rows, or null when none carry one.
 *
 * NOTE the scope this is called with. It is the newest sync among the rows
 * BEING CONSIDERED, not across the whole table, so a location whose every
 * member was stale would have a stale baseline and filter nobody. Checked
 * 2026-09-28: all 86 org units have at least one freshly-synced member, so the
 * baseline is sound everywhere today. If a site is ever fully re-orged in
 * Beekeeper, that is the failure to look for.
 */
export function latestSyncMs(
  rows: Iterable<RosterEligibilityRow>
): number | null {
  let max: number | null = null;
  for (const r of rows) {
    if (!r.synced_at) continue;
    const t = Date.parse(r.synced_at);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/** Filter a roster to the people still employed there, in one call. */
export function filterRosterEligible<T extends RosterEligibilityRow>(
  rows: T[]
): T[] {
  const newest = latestSyncMs(rows);
  return rows.filter((r) => isRosterEligible(r, newest));
}
