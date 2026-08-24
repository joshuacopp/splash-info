// The success-banner sentences shared by the greeter scorecard and its report
// view.
//
// EXTRACTED SO THERE IS ONE OF EACH SENTENCE. Voids can now be posted from
// /admin/greeters or from the drill-through on /admin/greeters/report, and both
// screens render a banner from the `success` key that comes back on the URL.
// When the two pages each kept their own wording, "site day voided" said one
// thing on one screen and something slightly different on the other for the
// identical action — which reads as though the two buttons did different things.
//
// The same key is deliberately used by both pages even though the report page
// only ever produces two of them; unrecognised keys render nothing (see the
// `?? null` at both call sites), so the extra entries cost nothing there.

/**
 * Keyed by the `success` query parameter that the server actions redirect with.
 *
 * WHAT THESE SAY. The save/delete lines just confirm the action, because the
 * result is visible in the table underneath. The void lines also say what the
 * strike-out DOES — the row drops out of every report and the day may come back
 * onto the missing-submissions watchlist — because neither consequence is
 * visible from where the button was pressed.
 *
 * The greeter-void line is CONDITIONAL and the site-void line is not, and that
 * asymmetry is real rather than sloppy: greeter_missing_days() flags a site's
 * day only when no live greeter rows remain for it, so voiding one greeter out
 * of three changes nothing on that list. Voiding the site's own totals always
 * does. The confirm dialogs on both pages are worded to match.
 */
export const SUCCESS_COPY: Record<string, string> = {
  day: "Greeter day saved.",
  day_edited: "Greeter day updated.",
  location: "Site-wide day saved.",
  location_edited: "Site-wide day updated.",
  goal: "Goal window saved.",
  goal_deleted: "Goal window deleted.",
  // THREE KEYS FOR ONE ENDPOINT. (site, month) is unique, so saving a month that
  // already had a target overwrites it — and "saved" would describe that as
  // though nothing had been there. The corrected line names the overwrite,
  // because the re-stamp tail that follows it is about to say that days already
  // logged have moved, and that only makes sense if the reader knows they were
  // measured against something else a moment ago.
  target: "Monthly labor budget and revenue goal saved.",
  target_corrected:
    "Monthly target updated — this month already had one, and the new figures replaced it.",
  target_deleted: "Monthly target deleted.",
  day_voided:
    "Greeter day voided. It's out of every report and rollup. If it was the last greeter logged for that site's day, the day counts as unreported again.",
  day_restored: "Greeter day restored.",
  location_voided:
    "Site-wide day voided. It's out of every report and rollup, and that day counts as unreported again.",
  location_restored: "Site-wide day restored."
};
