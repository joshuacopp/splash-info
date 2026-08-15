// The five typed-in scorecard numbers, shared by the greeter-day and
// location-day forms so the two can't drift apart.
//
// No "use client" on purpose: this is presentational markup with no hooks or
// handlers, so it renders as a server component inside the location-day form
// and gets pulled into the client bundle by GreeterDayForm. Keep it that way —
// adding state here would force the location-day form client-side too.
//
// D.O.B. and Capture % are deliberately absent: Postgres computes them
// (GENERATED ALWAYS ... STORED), matching the greyed formula cells in the
// spreadsheet this replaces. Typing them in would let the stored value
// disagree with its own inputs.

const labelCls =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const hintCls = "text-[11px] text-splash-navy/60";

export function MetricFields() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="flex flex-col gap-1">
        <span className={labelCls}>Total cars</span>
        <input
          type="number"
          name="total_cars"
          min="0"
          step="1"
          placeholder="0"
          className={inputCls}
        />
        <span className={hintCls}>Every car through the tunnel.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>Wash sales (ALC)</span>
        <input
          type="number"
          name="wash_sales"
          min="0"
          step="1"
          placeholder="0"
          className={inputCls}
        />
        <span className={hintCls}>
          A-la-carte, non-unlimited cars. Drives D.O.B. and capture %.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>Sign ups</span>
        <input
          type="number"
          name="sign_ups"
          min="0"
          step="1"
          placeholder="0"
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>Package $</span>
        <input
          type="number"
          name="package_dollars"
          min="0"
          step="0.01"
          placeholder="0.00"
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>Extras $</span>
        <input
          type="number"
          name="extras_dollars"
          min="0"
          step="0.01"
          placeholder="0.00"
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>Comments</span>
        <input
          type="text"
          name="comments"
          maxLength={2000}
          placeholder="Optional"
          className={inputCls}
        />
      </label>
    </div>
  );
}
