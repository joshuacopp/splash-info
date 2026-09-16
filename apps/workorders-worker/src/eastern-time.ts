// Eastern-time calendar boundaries.
//
// WHY EASTERN AND NOT UTC
//
//   Every site is in the Eastern zone and MaintainX stores due dates as real
//   timestamps authored in local time -- MEASURED over eight weeks, the
//   preventive due times are round hours in EASTERN (9 PM x1768, 11 PM x1674,
//   10 AM x969, 10 PM x742) and ragged ones in UTC. Because most of them fall
//   late in the evening, 67% of preventive work orders land on a DIFFERENT
//   calendar day in UTC than the day an operator would name. Any day- or
//   week-boundary arithmetic done in UTC is therefore wrong about two thirds
//   of preventive work by one day.
//
// WHY THESE LIVE TOGETHER
//
//   The daily digest, the due-date pills and the on-time percentage all have
//   to agree on when a day starts, or the page contradicts itself and the
//   email contradicts the page. One implementation, imported everywhere.

const EASTERN_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZoneName: "longOffset"
});

const EASTERN_WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short"
});

/** The UTC offset in force at `at`, as "-04:00" / "-05:00". Read from the
 *  platform's tz database rather than a rule of our own -- hardcoding -04:00
 *  is wrong for four months of the year. */
export function easternOffsetAt(at: Date): string {
  const parts = new Map(EASTERN_PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  return (parts.get("timeZoneName") ?? "GMT+00:00").replace("GMT", "") || "+00:00";
}

/** Eastern calendar date of `at`, as "YYYY-MM-DD". */
export function easternYmd(at: Date): string {
  const parts = new Map(EASTERN_PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

/**
 * Eastern-day start for the day CONTAINING `at`, as an ISO instant.
 *
 * The offset has to be the one in force AT MIDNIGHT, which is not necessarily
 * the one in force at `at`: on the two changeover days a year they differ, and
 * using the wrong one puts the boundary an hour into the neighbouring day. So
 * the first offset is only a guess, and the second read -- taken at the
 * instant the guess produced -- is the one that decides.
 */
export function easternDayStartOf(at: Date): string {
  const ymd = easternYmd(at);
  const guess = new Date(`${ymd}T00:00:00${easternOffsetAt(at)}`);
  return new Date(`${ymd}T00:00:00${easternOffsetAt(guess)}`).toISOString();
}

const DAY_MS = 86_400_000;
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6
};

/** Days from the most recent Monday to the Eastern day containing `at`.
 *  Monday itself is 0, Sunday is 6. */
export function easternDaysSinceMonday(at: Date): number {
  const name = EASTERN_WEEKDAY.format(at);
  return WEEKDAY_INDEX[name] ?? 0;
}

/**
 * Monday 00:00 Eastern of the week containing `at`, as an ISO instant.
 *
 * Walks back to midday of the target Monday before re-deriving the day start,
 * rather than subtracting a flat number of 24-hour blocks -- the week
 * containing a DST change is 167 or 169 hours long, so flat arithmetic lands
 * an hour off and, at the boundary, on the wrong day entirely.
 */
export function easternWeekStartOf(at: Date): string {
  const todayStart = Date.parse(easternDayStartOf(at));
  const back = easternDaysSinceMonday(at) * DAY_MS;
  // +12h puts us at midday on the Monday, comfortably clear of either
  // boundary whatever the offset did in between.
  return easternDayStartOf(new Date(todayStart - back + DAY_MS / 2));
}

/** Start of the Eastern day AFTER the one containing `at`. Used as an
 *  exclusive upper bound for "everything up to and including today". */
export function easternNextDayStartOf(at: Date): string {
  const todayStart = Date.parse(easternDayStartOf(at));
  return easternDayStartOf(new Date(todayStart + DAY_MS + DAY_MS / 2));
}
