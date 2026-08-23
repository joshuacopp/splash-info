// The typed-in scorecard numbers for the two day forms.
//
// Deliberately TWO components sharing a private field set rather than one
// shared component: the greeter's day and the site's day no longer collect the
// same metrics, and a single component with `variant` props would have to
// re-derive which fields apply on every render and would drift the first time
// one side gained a field.
//
// What differs, and why:
//   total_cars       Site only. Every greeter on shift would type the same
//                    tunnel count, and summing across a crew would multiply the
//                    site's day by the size of the crew.
//   cancellations    Site only. Nobody cancels at a specific greeter's window.
//   total_members    Site only, and a LEVEL rather than a daily amount — the
//                    active member count as of that day. Never summed.
//   rewashes         Both, but the site's figure is the authoritative one; the
//                    greeter's copy is optional context.
//   reactivations    Both, and asymmetric on purpose. The site's copy is a real
//                    input — Postgres generates net_members from it. The
//                    greeter's copy is optional and informational only: nothing
//                    is computed from it, and it is NOT part of capture %,
//                    because a returning member was never a new opportunity.
//   churn_pct        Site only, and a PERCENTAGE rather than a count — the one
//                    box on either form that isn't a raw tally. A greeter has no
//                    member base to churn. Informational: no goal, no grading.
//   google_reviews   Both, informational on both. A COUNT of reviews collected,
//                    not a star rating.
//
// No "use client" on purpose: this is presentational markup with no hooks or
// handlers, so it renders as a server component inside the location-day form
// and gets pulled into the client bundle by GreeterDayForm. Keep it that way —
// adding state here would force the location-day form client-side too.
//
// D.O.B. and Capture % are deliberately absent from both: Postgres computes
// them (GENERATED ALWAYS ... STORED), matching the greyed formula cells in the
// spreadsheet this replaces. Typing them in would let the stored value disagree
// with its own inputs. Hours worked and wash sales per hour are the same deal —
// they come from the shift window, not from a box.

// The two Edit row types rather than the full GreeterDailyRow / LocationDailyRow:
// the pages that render these forms only ever hold the column subset the list
// endpoints return, so a prop typed as the whole row could never be satisfied.
// See the doc on GreeterDayEditRow.
import type {
  GreeterDayEditRow,
  LocationDayEditRow
} from "@splash/types/greeter";

const labelCls =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const hintCls = "text-[11px] text-splash-navy/60";
const gridCls = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

/**
 * A stored value as an input's defaultValue.
 *
 * NULL BECOMES EMPTY, NOT ZERO, and the distinction is the whole point of this
 * function. Every metric here is nullable, and a blank box means "not reported"
 * while a 0 means "reported, and it was none" — a site that logged no sign-ups
 * is a different fact from a site that didn't say. Rendering null as 0 would
 * turn the second into the first the moment anybody opened the row to edit an
 * unrelated field.
 */
function fieldValue(v: number | string | null | undefined): string {
  return v == null ? "" : String(v);
}

/**
 * `pct` caps the input at 100 and allows two decimals. The max is a courtesy —
 * a browser will still let a determined user submit past it, so the real
 * enforcement is the worker's 400 and the DB's CHECK. It exists to catch the
 * fat-finger at the point where it's cheapest to fix.
 *
 * `defaultValue` rather than `value`: these stay uncontrolled so the fields need
 * no state and this file needs no "use client". The consequence is that React
 * only picks up a new default when the input is REMOUNTED, so whatever renders
 * these in edit mode must key the form on the row id — otherwise switching from
 * one row's edit form to another's leaves the first row's numbers on screen.
 */
function NumberField({
  name,
  label,
  hint,
  money = false,
  pct = false,
  defaultValue
}: {
  name: string;
  label: string;
  hint?: string;
  money?: boolean;
  pct?: boolean;
  defaultValue?: number | string | null;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      <input
        type="number"
        name={name}
        min="0"
        max={pct ? "100" : undefined}
        step={money || pct ? "0.01" : "1"}
        placeholder={money || pct ? "0.00" : "0"}
        defaultValue={fieldValue(defaultValue)}
        className={inputCls}
      />
      {hint ? <span className={hintCls}>{hint}</span> : null}
    </label>
  );
}

function CommentsField({ defaultValue }: { defaultValue?: string | null }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelCls}>Comments</span>
      <input
        type="text"
        name="comments"
        maxLength={2000}
        placeholder="Optional"
        defaultValue={fieldValue(defaultValue)}
        className={inputCls}
      />
    </label>
  );
}

/**
 * What one greeter reports for their own day. No tunnel volume, no member roll.
 *
 * `row` present means this is an edit. The goal snapshot columns on the row are
 * deliberately NOT rendered as fields: capture_goal_pct and dob_goal are
 * re-resolved server-side from the business date on every save, so a box for
 * them would collect a number the worker then overwrites.
 */
export function GreeterMetricFields({ row }: { row?: GreeterDayEditRow | null }) {
  return (
    <div className={gridCls}>
      <NumberField
        name="wash_sales"
        label="Wash sales (ALC)"
        hint="A-la-carte, non-unlimited cars. Drives D.O.B. and capture %."
        defaultValue={row?.wash_sales}
      />
      <NumberField
        name="sign_ups"
        label="Sign ups"
        hint="Unlimited memberships sold."
        defaultValue={row?.sign_ups}
      />
      <NumberField
        name="reactivations"
        label="Reactivations"
        hint="Optional. Lapsed members you brought back. Not counted in capture %."
        defaultValue={row?.reactivations}
      />
      <NumberField
        name="package_dollars"
        label="Package $"
        money
        defaultValue={row?.package_dollars}
      />
      <NumberField
        name="extras_dollars"
        label="Extras $"
        money
        defaultValue={row?.extras_dollars}
      />
      <NumberField
        name="rewashes"
        label="Rewashes"
        hint="Optional. The site's total is the number that counts."
        defaultValue={row?.rewashes}
      />
      <NumberField
        name="google_reviews"
        label="Google reviews"
        hint="Optional. How many reviews you got today — a count, not a rating."
        defaultValue={row?.google_reviews}
      />
      <CommentsField defaultValue={row?.comments} />
    </div>
  );
}

/** The whole location's day, not attributed to anyone. See GreeterMetricFields
 *  for what `row` does and why the goal columns aren't fields. */
export function LocationMetricFields({
  row
}: {
  row?: LocationDayEditRow | null;
}) {
  return (
    <div className={gridCls}>
      <NumberField
        name="total_cars"
        label="Total cars"
        hint="Every car through the tunnel, members included."
        defaultValue={row?.total_cars}
      />
      <NumberField
        name="wash_sales"
        label="Wash sales (ALC)"
        hint="A-la-carte, non-unlimited cars. Drives D.O.B. and capture %."
        defaultValue={row?.wash_sales}
      />
      {/* The two unscannable-car boxes, adjacent because they do the same job:
          each is a real wash sale that no customer could have scanned a card
          for, and the scan rate subtracts both before dividing. Neither one
          changes capture % or D.O.B. — those stay on gross wash sales. */}
      <NumberField
        name="house_accounts"
        label="House accounts"
        hint="Cars washed on a house account. Counts as a wash sale, but can't be scanned — so it comes out of the scan-rate denominator."
        defaultValue={row?.house_accounts}
      />
      <NumberField
        name="rewashes"
        label="Rewashes"
        hint="Also unscannable, and also deducted from the scan rate."
        defaultValue={row?.rewashes}
      />
      <NumberField
        name="package_dollars"
        label="Package $"
        money
        defaultValue={row?.package_dollars}
      />
      <NumberField
        name="extras_dollars"
        label="Extras $"
        money
        defaultValue={row?.extras_dollars}
      />
      <NumberField
        name="sign_ups"
        label="Sign ups"
        defaultValue={row?.sign_ups}
      />
      <NumberField
        name="reactivations"
        label="Reactivations"
        hint="Lapsed members reinstated today. Counts toward net members."
        defaultValue={row?.reactivations}
      />
      <NumberField
        name="cancellations"
        label="Cancellations"
        hint="Memberships cancelled today."
        defaultValue={row?.cancellations}
      />
      <NumberField
        name="total_members"
        label="Total members"
        hint="Active members as of today — a running total, not today's adds."
        defaultValue={row?.total_members}
      />
      <NumberField
        name="churn_pct"
        label="Churn %"
        pct
        hint="Optional. Today's churn as a percentage, 0-100. Reported, not graded."
        defaultValue={row?.churn_pct}
      />
      <NumberField
        name="google_reviews"
        label="Google reviews"
        hint="Optional. Reviews collected today — a count, not a rating."
        defaultValue={row?.google_reviews}
      />
      <CommentsField defaultValue={row?.comments} />
    </div>
  );
}
