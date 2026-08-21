// The budget editor — the workbook's BUDGET row, made editable.
//
// A SERVER COMPONENT, and one <form> PER CATEGORY.
//
// WHY THIRTEEN FORMS AND NOT ONE: the worker's budget endpoint takes a single
// (location, month, category) triple. One form with thirteen inputs would have
// to fan out into thirteen POSTs inside the action and then decide what to say
// when the fourth one fails — "saved 3 of 13" is a state nobody can act on, and
// the retry re-posts the nine that already worked. One form per category makes
// each save atomic and each failure legible, at the cost of a save button per
// row. The HTML is also simpler: a <form> per row means no `form=` attribute
// plumbing to get a submit button out of a table cell.
//
// WHY IT NEEDS A LOCATION: a budget is per site per month per category. With
// the page's location filter empty there is no single site to edit, and
// inventing an "apply to all sites" mode here would be a policy decision (does
// it overwrite? what about sites the caller can't see?) rather than a UI one.
// The editor says so and points at the filter instead.
//
// BLANK MEANS "NEVER SET" AND STAYS THAT WAY. An unbudgeted category renders
// with an empty input, not a zero, and submitting it blank is rejected by the
// action rather than being sent as 0 — see saveBudgetAction. There is no way to
// clear a budget once set; the contract has no delete and this UI does not
// pretend otherwise.

import { SavingButton } from "../../greeters/_components/SavingButton";
import {
  RedirectForm,
  type RedirectResult
} from "../../_components/RedirectForm";
import { HINT_CLS, INPUT_CLS, LABEL_CLS } from "../_lib/ui";
import { monthLabel } from "../_lib/format";
import type { CategoryOption } from "./ExpenseEntryForm";

/** The subset of expense_budget the editor reads back. */
export interface BudgetValue {
  category_key: string;
  budget_amount: number;
  note: string | null;
}

export function BudgetEditor({
  saveAction,
  copyAction,
  categories,
  budgets,
  month,
  prevMonth,
  locationId,
  locationLabel,
  returnQs
}: {
  saveAction: (formData: FormData) => Promise<RedirectResult>;
  copyAction: (formData: FormData) => Promise<RedirectResult>;
  categories: CategoryOption[];
  budgets: BudgetValue[];
  /** YYYY-MM-01, already normalised by the page. */
  month: string;
  /** YYYY-MM-01 for the copy source. */
  prevMonth: string;
  locationId?: number;
  locationLabel?: string;
  returnQs: string;
}) {
  if (locationId === undefined) {
    return (
      <p className="px-5 py-6 text-sm text-splash-navy/70">
        Pick a location in the filter bar to set budgets. A budget belongs to one
        site for one month — there is nothing to edit across all sites at once.
      </p>
    );
  }

  // Keyed lookup so a thirteen-row render doesn't scan the budget array
  // thirteen times, and so "absent" is a clean `undefined` rather than a
  // find() that returned nothing.
  const byCategory = new Map<string, BudgetValue>();
  for (const b of budgets) byCategory.set(b.category_key, b);

  const setCount = byCategory.size;

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* Carry forward. Sits above the grid because it is the thing most people
          want on the first of the month, and typing thirteen numbers again is
          how a budget row quietly stops being maintained. */}
      <RedirectForm
        action={copyAction}
        className="flex flex-wrap items-center gap-3 rounded-splash-md border border-gray-light bg-splash-navy/5 p-4"
      >
        <input type="hidden" name="return_qs" value={returnQs} />
        <input type="hidden" name="location_id" value={locationId} />
        <input type="hidden" name="from_month" value={prevMonth} />
        <input type="hidden" name="to_month" value={month} />
        <div className="flex-1">
          <p className="text-sm font-semibold text-splash-navy">
            Copy {monthLabel(prevMonth)} → {monthLabel(month)}
          </p>
          {/* ON CONFLICT DO NOTHING in the database, so this is safe to press
              twice and safe to press after editing. Said out loud because the
              button has no confirmation step and people will hesitate. */}
          <p className={HINT_CLS}>
            Copies last month&rsquo;s budget for {locationLabel ?? "this site"}.
            Categories already budgeted this month keep the number they have —
            nothing is overwritten, and running it again does nothing.
          </p>
        </div>
        <SavingButton savingLabel="Copying…">Copy last month</SavingButton>
      </RedirectForm>

      <p className={HINT_CLS}>
        {setCount === 0
          ? `No budget has been set for ${monthLabel(month)} yet. Every category shows a dash on the grid above until one is — a blank budget is not a budget of zero.`
          : `${setCount} of ${categories.length} categories budgeted for ${monthLabel(month)}. The rest show a dash on the grid above, not a zero.`}
      </p>

      <div className="flex flex-col divide-y divide-gray-light">
        {categories.map((c) => {
          const existing = byCategory.get(c.key);
          const heading = c.group_label
            ? `${c.group_label} · ${c.label}`
            : c.label;
          return (
            <RedirectForm
              key={c.key}
              action={saveAction}
              className="grid grid-cols-1 items-end gap-3 py-3 sm:grid-cols-[minmax(0,12rem)_9rem_minmax(0,1fr)_auto]"
            >
              <input type="hidden" name="return_qs" value={returnQs} />
              <input type="hidden" name="period_month" value={month} />
              <input type="hidden" name="location_id" value={locationId} />
              <input type="hidden" name="category_key" value={c.key} />

              <div className="flex flex-col gap-1">
                <span className={LABEL_CLS}>{heading}</span>
                {/* "Copied from Mon YYYY" is stamped by the copy function, so
                    this line is how a carried-forward number is told apart from
                    one somebody actually typed. */}
                {existing?.note ? (
                  <span className={HINT_CLS}>{existing.note}</span>
                ) : null}
              </div>

              <label className="flex flex-col gap-1">
                <span className="sr-only">{heading} budget amount</span>
                <input
                  type="number"
                  name="budget_amount"
                  step="0.01"
                  // A budget IS constrained non-negative, unlike an entry
                  // amount on the same page. min mirrors the CHECK; the action
                  // re-checks because min is trivially bypassed.
                  min="0"
                  inputMode="decimal"
                  placeholder="not set"
                  defaultValue={
                    // Empty string, NOT 0, when there is no budget row. An
                    // input pre-filled with 0 would make "never set" one
                    // careless Save away from becoming a real zero ceiling,
                    // which reads as a 100% overspend on the grid.
                    existing ? existing.budget_amount.toFixed(2) : ""
                  }
                  className={INPUT_CLS}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="sr-only">{heading} note</span>
                <input
                  type="text"
                  name="note"
                  placeholder="Note (optional)"
                  defaultValue={existing?.note ?? ""}
                  className={INPUT_CLS}
                />
              </label>

              <SavingButton>{existing ? "Update" : "Set"}</SavingButton>
            </RedirectForm>
          );
        })}
      </div>
    </div>
  );
}
