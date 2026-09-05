// Weekly greeter digest — the data half.
//
// This module decides WHAT last week looked like for each enrolled site. It does
// not decide who receives it (listGreeterDigestRecipients, in @splash/db-supabase)
// and it does not render anything (digest-render.ts). Keeping those three apart
// is what makes the preview route able to show a real week without sending mail.
//
// THE ARITHMETIC IS NOT HERE EITHER. Every number comes out of
// @splash/greeter-metrics, the same module /admin/greeters/report renders from.
// That is the entire reason that package was extracted: the manager who reads
// Monday's email opens the report on Tuesday, and if the two disagreed by a
// decimal the only thing they would learn is not to trust either. Do not compute
// a rate in this file. Sum a numerator here and you have started a second
// implementation.
//
// ONE FETCH FOR THE WHOLE ESTATE, SLICED PER PERSON. Twelve recipients share ten
// sites, so fetching per recipient would re-read the same site eight or nine
// times. buildDigestBlocks() reads once for the union of enrolled codes and
// sliceForRecipient() takes each person's cut out of the result.

import {
  listGreeterMissingDays,
  listGreeterPeriodReport,
  listLocationPeriodRows,
  type SupabaseClient
} from "@splash/db-supabase";
import { bySite, type SiteTotals } from "@splash/greeter-metrics";
import type {
  GreeterDigestRecipient,
  GreeterPeriodReportRow
} from "@splash/types/greeter";

/* ============================================================
 * The window
 * ============================================================ */

export interface DigestWeek {
  /** Monday of the completed week, inclusive. */
  from: string;
  /** Sunday of the completed week, inclusive. */
  to: string;
  /** Monday of the week before that — the comparison basis. */
  prior_from: string;
  prior_to: string;
}

/**
 * The last COMPLETE Monday-to-Sunday week before `now`, plus the week before it.
 *
 * DERIVED FROM THE DAY OF WEEK, NOT FROM "seven days ago". The cron fires on a
 * Monday, so subtracting seven days would happen to work — but the preview route
 * runs on whatever day somebody opens it, and a Wednesday preview must show the
 * same week Monday's mail showed, or it is not a preview. Anchoring on the
 * containing Monday makes the answer constant for the whole week, which is also
 * what lets the send loop key on it for idempotency.
 *
 * ALL UTC, deliberately. The cron is pinned to 09:00 UTC rather than a local 4am
 * precisely so nothing has to track DST twice a year; doing the date arithmetic
 * in local time would put the drift back. The consequence to know about: a
 * preview opened late on a Sunday evening Eastern is already Monday in UTC and
 * will roll to the new week a few hours before it "feels" like it should.
 */
export function digestWeekFor(now: Date): DigestWeek {
  const today = isoFromDate(now);
  // getUTCDay: 0=Sunday .. 6=Saturday. Shift so Monday is 0.
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const thisMonday = isoAdd(today, -sinceMonday);

  const from = isoAdd(thisMonday, -7);
  const to = isoAdd(thisMonday, -1);
  return {
    from,
    to,
    prior_from: isoAdd(from, -7),
    prior_to: isoAdd(from, -1)
  };
}

/** `YYYY-MM-DD` for a Date, read in UTC. */
function isoFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Add days to a `YYYY-MM-DD` string, staying in UTC.
 *
 * Built from Date.UTC rather than `new Date(iso)` arithmetic so it cannot pick
 * up a local offset: the strings in and out are business dates, which have no
 * time zone at all, and the moment one acquires an implied one it starts landing
 * on the wrong side of midnight.
 */
function isoAdd(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/* ============================================================
 * The per-site block
 * ============================================================ */

/**
 * One enrolled site's week, as the email renders it.
 *
 * THREE QUESTIONS IN ONE SHAPE, matching the three the digest was asked for:
 * did the site report at all (`days_missing_*`), how did the site do
 * (`totals` / `prior`), and how did its greeters do (`greeters`). They are kept
 * as separate fields rather than pre-merged because a site can fail the first
 * and still have data for the third — a week where the site never posted its own
 * numbers but four greeters posted theirs is a real and common state, and the
 * email has to say both things.
 */
export interface DigestSiteBlock {
  location_code: string;
  /**
   * Null when the site produced no rows anywhere this week. An enrolled site
   * that reported nothing has no row to read a site_number off, and inventing
   * one from the enrollment table is not possible — enrollment stores a code and
   * nothing else.
   */
  site_number: number | null;
  /** Null when no site day was logged. NOT a zeroed Totals: see below. */
  totals: SiteTotals | null;
  /** Null when the prior week is also empty, which suppresses every delta. */
  prior: SiteTotals | null;
  /**
   * Business dates in the window with no location_daily row. The site's own
   * numbers are missing for these days.
   */
  days_missing_site: string[];
  /**
   * Business dates in the window where no greeter logged anything. Tracked
   * separately from days_missing_site because they have different owners: one is
   * the manager not posting the site's day, the other is the crew not posting
   * theirs, and a digest that merged them would tell neither person what to fix.
   */
  days_missing_greeters: string[];
  greeters: GreeterPeriodReportRow[];
}

/**
 * Build a block for every enrolled code over the given week.
 *
 * SEEDED FROM `codes`, NOT FROM THE QUERY RESULTS, and that is load-bearing. A
 * site that logged nothing appears in none of the three reads — and one of them,
 * greeter_missing_days(), only grids sites it considers onboarded, so a silent
 * site can be absent even from the "what's missing" answer. Seeding from the
 * enrollment list is what guarantees such a site still gets a block, and so
 * still gets a paragraph in the email saying it went quiet. That was an explicit
 * product decision: zero-submission sites DO receive a digest.
 *
 * `totals` STAYS NULL FOR A SILENT SITE rather than becoming a zeroed Totals.
 * Zeros would render as a genuine week of zero wash sales, which is a different
 * and much more alarming claim than "nobody told us".
 */
export async function buildDigestBlocks(
  client: SupabaseClient,
  codes: string[],
  week: DigestWeek
): Promise<Map<string, DigestSiteBlock>> {
  const scope = [...new Set(codes)].sort();
  const blocks = new Map<string, DigestSiteBlock>();
  for (const code of scope) {
    blocks.set(code, {
      location_code: code,
      site_number: null,
      totals: null,
      prior: null,
      days_missing_site: [],
      days_missing_greeters: [],
      greeters: []
    });
  }
  if (scope.length === 0) return blocks;

  const window = { date_from: week.from, date_to: week.to };
  const priorWindow = { date_from: week.prior_from, date_to: week.prior_to };
  const filters = { location_scope: scope };

  const [siteRows, priorRows, missing, greeters] = await Promise.all([
    listLocationPeriodRows(client, window, filters),
    listLocationPeriodRows(client, priorWindow, filters),
    listGreeterMissingDays(client, window, filters),
    listGreeterPeriodReport(client, window, filters)
  ]);

  for (const t of bySite(siteRows)) {
    const block = blocks.get(t.location_code);
    if (!block) continue;
    block.totals = t;
    block.site_number = t.site_number;
  }

  // Prior totals attach to the SAME block, so a site that reported last week and
  // went quiet this week keeps its prior figures and renders as a fall to
  // nothing rather than disappearing.
  for (const t of bySite(priorRows)) {
    const block = blocks.get(t.location_code);
    if (!block) continue;
    block.prior = t;
    block.site_number ??= t.site_number;
  }

  for (const row of missing) {
    const block = blocks.get(row.location_code);
    if (!block) continue;
    block.site_number ??= row.site_number;
    // greeter_missing_days() returns a day when EITHER side is absent, so both
    // flags have to be tested — a row is not proof that both are missing.
    if (!row.has_site_row) block.days_missing_site.push(row.business_date);
    if (row.greeters_logged === 0) {
      block.days_missing_greeters.push(row.business_date);
    }
  }

  for (const row of greeters) {
    const block = blocks.get(row.location_code);
    if (!block) continue;
    block.site_number ??= row.site_number;
    block.greeters.push(row);
  }

  for (const block of blocks.values()) {
    block.days_missing_site.sort();
    block.days_missing_greeters.sort();
    // Worst capture first, but never a low-sample row at the top: two days and
    // both missed reads as "100% under goal" and would otherwise lead the
    // section. Same rule the report's performer lists follow.
    block.greeters.sort(compareGreeters);
  }

  return blocks;
}

function compareGreeters(
  a: GreeterPeriodReportRow,
  b: GreeterPeriodReportRow
): number {
  if (a.low_sample !== b.low_sample) return a.low_sample ? 1 : -1;
  const ac = a.capture_pct;
  const bc = b.capture_pct;
  // A greeter with no gradeable capture sorts below one who has a rate, in
  // either direction — there is nothing to rank them on.
  if (ac === null && bc === null) return a.greeter_name.localeCompare(b.greeter_name);
  if (ac === null) return 1;
  if (bc === null) return -1;
  if (ac !== bc) return bc - ac;
  return a.greeter_name.localeCompare(b.greeter_name);
}

/**
 * One recipient's blocks, in the order the email lists them.
 *
 * Silently drops codes with no block instead of throwing. The only way that
 * happens is a site un-enrolled between the recipient resolution and this call,
 * and dropping a section is the correct response to "this site is no longer part
 * of the digest" — failing the whole send for one person's stale code would not
 * be.
 */
export function sliceForRecipient(
  blocks: Map<string, DigestSiteBlock>,
  recipient: GreeterDigestRecipient
): DigestSiteBlock[] {
  const out: DigestSiteBlock[] = [];
  for (const code of recipient.location_codes) {
    const block = blocks.get(code);
    if (block) out.push(block);
  }
  return out;
}
