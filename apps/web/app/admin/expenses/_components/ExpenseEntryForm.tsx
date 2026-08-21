// The entry form — one purchase, one category, one amount.
//
// A CLIENT COMPONENT AS OF 2026-08-21. It used to be a server component, and
// the note that stood here said "nothing needs state". That stopped being true
// when maintenance labor arrived: the category now decides which fields the rest
// of the form even has, so the selection has to live in React state.
//
// What did NOT change: the PO number is still never predicted (see the initials
// hint), the location picker and the save button are still the same client
// components they always were, and the action is still a server action handed
// down from the page.
//
// FIELD ORDER *USED* TO MIRROR THE WORKBOOK'S ROW 7+ (DATE | PO | METHOD |
// DESCRIPTION | amount), with category last. As of 2026-08-21 CATEGORY SITS
// ABOVE METHOD, deliberately breaking that mirror.
//
// The reason is that category is no longer just a filing decision made after
// the fact — it now GOVERNS THE REST OF THE FORM. Maintenance labor is billed
// in hours, not dollars, and has no payment method at all, so method and amount
// only make sense once the category is known. Asking for method first would be
// asking a question that the next answer can retract.
//
// Location still leads (chosen once for a whole stack) and date still leads
// with it (it's inside the PO number).
//
//
// THE HOURLY BRANCH IS DRIVEN BY `billed_by_hours`, NEVER BY A CATEGORY KEY.
// The column exists precisely so the form, the worker and insert_expense_entry()
// agree without three copies of the string "maintenance_labor". If a second
// hourly category is ever added it is a row in expense_categories and nothing
// here changes.
//
// FIELDS FOR THE OTHER BRANCH ARE UNMOUNTED, NOT HIDDEN. An `amount` input left
// in the DOM with display:none still posts its value, and the worker tells the
// two shapes apart by which fields are present. Unmounting is what makes "a
// labor entry has no payment method" true on the wire and not just on screen.
//
// THE DOLLAR PREVIEW IS AN ESTIMATE AND SAYS SO. The stored amount is computed
// by the database from the rate in force on the business date; this component
// resolves the same rate from the same history to show the number before saving.
// The two agree today. If they ever disagree, the database is right — which is
// why the preview is never posted (see actions.ts).

"use client";

import { useState, type ReactNode } from "react";
import { LocationPicker } from "../../performance/_components/LocationPicker";
import { SavingButton } from "../../greeters/_components/SavingButton";
import {
  RedirectForm,
  type RedirectResult
} from "../../_components/RedirectForm";
import { HINT_CLS, INPUT_CLS, LABEL_CLS } from "../_lib/ui";

/** The subset of expense_categories the form needs. The worker's /categories
 *  projection is narrower than the table, so this is stated rather than
 *  imported wholesale. */
export interface CategoryOption {
  key: string;
  group_label: string | null;
  label: string;
  sort_order: number;
  /** Ask for hours instead of dollars, and drop the payment method. */
  billed_by_hours: boolean;
}

/** The subset of expense_labor_rate the preview needs. */
export interface LaborRateOption {
  mechanic_key: string | null;
  effective_from: string;
  rate_per_hour: number;
}

/**
 * Common METHOD values, offered as a DATALIST and not a SELECT.
 *
 * The column is free text in the schema on purpose: sites use their own words
 * for the same card and a closed vocabulary would reject a legitimate entry at
 * 6pm with nobody around to migrate it. A datalist suggests without
 * constraining, which is exactly the intended posture.
 */
const METHOD_SUGGESTIONS = [
  "Company Card",
  "Fuel Card",
  "Check",
  "Cash",
  "Petty Cash",
  "Invoice / Net Terms",
  "Personal (reimburse)"
];

/**
 * Money, for the preview only.
 *
 * Local rather than imported from ../_lib/format so this client bundle doesn't
 * pull in a module of table cells it will never render. It is two lines and it
 * formats one number.
 */
function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * The rate in force on a date — the same rule as expense_labor_rate_for():
 * newest row whose effective_from is on or before the date.
 *
 * RESOLVED BY DATE, NOT `rates[0]`. Taking the newest row outright is correct
 * until somebody schedules a raise for next month, at which point it would price
 * today's work at next month's rate — and backdated entries, which this form
 * explicitly supports, would be priced wrong in the other direction.
 *
 * COMPANY-WIDE ROWS ONLY (mechanic_key null). Per-mechanic rates resolve in the
 * database already but nothing in this form collects a mechanic, so including
 * them here would show a preview the insert would not reproduce.
 */
function rateOn(rates: LaborRateOption[], date: string): number | null {
  if (!date) return null;
  let best: LaborRateOption | null = null;
  for (const r of rates) {
    if (r.mechanic_key !== null) continue;
    if (r.effective_from > date) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best ? best.rate_per_hour : null;
}

/**
 * Group the flat category list into <optgroup>s.
 *
 * Runs of CONSECUTIVE rows sharing a group_label, not a keyed bucket: the list
 * arrives ordered by sort_order and that order is the workbook's left-to-right
 * column order, which is the order operators know. Bucketing by label would
 * quietly reorder the menu the first time somebody inserts a category between
 * two groups.
 *
 * A null group_label is a standalone option at the top level (Refunds), not an
 * optgroup with an empty heading.
 */
function groupCategories(
  categories: CategoryOption[]
): { group: string | null; items: CategoryOption[] }[] {
  const runs: { group: string | null; items: CategoryOption[] }[] = [];
  for (const c of categories) {
    const last = runs[runs.length - 1];
    if (last && last.group !== null && last.group === c.group_label) {
      last.items.push(c);
    } else {
      runs.push({ group: c.group_label, items: [c] });
    }
  }
  return runs;
}

export function ExpenseEntryForm({
  action,
  categories,
  laborRates,
  returnQs,
  defaultDate,
  defaultLocationId,
  defaultLocationLabel,
  dateNote
}: {
  action: (formData: FormData) => Promise<RedirectResult>;
  categories: CategoryOption[];
  /** Every rate ever set, for the hourly preview. Empty is a real state: no
   *  administrator has set one yet, and the form says so rather than guessing. */
  laborRates: LaborRateOption[];
  /** The page's current query string, so the navigation lands back on this view. */
  returnQs: string;
  /** "" when the viewed month isn't the current one — see the page. */
  defaultDate: string;
  defaultLocationId?: number;
  defaultLocationLabel?: string;
  /** Rendered under the date when the default was deliberately left blank. */
  dateNote?: ReactNode;
}) {
  const groups = groupCategories(categories);

  // The date is state, not just a defaultValue, because the hourly preview has
  // to reprice when it changes: the rate is the one in force on the PURCHASE
  // date, and this form is used to backdate.
  const [businessDate, setBusinessDate] = useState(defaultDate);
  const [categoryKey, setCategoryKey] = useState("");
  const [hours, setHours] = useState("");

  const selected = categories.find((c) => c.key === categoryKey) ?? null;
  const hourly = selected?.billed_by_hours ?? false;

  const rate = hourly ? rateOn(laborRates, businessDate) : null;
  const hoursNum = Number(hours);
  const preview =
    rate !== null && hours.trim() !== "" && Number.isFinite(hoursNum) && hoursNum > 0
      ? Math.round(hoursNum * rate * 100) / 100
      : null;

  return (
    <RedirectForm action={action} className="flex flex-col gap-4 px-5 py-5">
      <input type="hidden" name="return_qs" value={returnQs} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Purchase date *</span>
          <input
            type="date"
            name="business_date"
            required
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
            className={INPUT_CLS}
          />
          {/* The date is not just a date: it is the YYYYMMDD inside the PO and
              the day the sequence counts within. Backdating an entry allocates
              the next number for THAT day, not for today. */}
          <span className={HINT_CLS}>
            {dateNote ??
              "Also the date inside the PO number, and the day its sequence counts within."}
          </span>
        </label>

        <div className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Location *</span>
          <LocationPicker
            name="location_id"
            required
            defaultValue={defaultLocationId}
            defaultLabel={defaultLocationLabel}
            placeholder="Search by site number, name, or code…"
          />
          <span className={HINT_CLS}>
            The site number in front of the PO comes from here.
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Your initials *</span>
          <input
            type="text"
            name="po_initials"
            required
            maxLength={4}
            // Mirrors the database CHECK (`^[A-Z]{1,4}$`, uppercased on the way
            // in). Client-side it only saves a round trip; the constraint is
            // the guarantee.
            pattern="[A-Za-z]{1,4}"
            title="1–4 letters"
            placeholder="JC"
            autoComplete="off"
            className={`${INPUT_CLS} uppercase`}
          />
          {/*
            THE FORMAT IS SHOWN, THE NUMBER IS NOT PREDICTED.

            The trailing sequence is "which order of the day is this for this
            site", allocated inside next_expense_po() under an advisory lock at
            insert time. Anything this form displayed before saving would be a
            guess that goes stale the moment somebody else at the same site
            saves first — and it would be a guess about the one field people
            write on a paper invoice. The real number is echoed back in the
            success banner instead.
          */}
          <span className={HINT_CLS}>
            The PO number is assigned when you save:{" "}
            <span className="font-mono">
              site-YYYYMMDD{"{initials}"}
              {"{n}"}
            </span>
            , e.g. <span className="font-mono">196-20260820JC1</span>. You&rsquo;ll
            see the full number on the confirmation.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Category *</span>
          <select
            name="category_key"
            required
            value={categoryKey}
            onChange={(e) => setCategoryKey(e.target.value)}
            className={INPUT_CLS}
          >
            <option value="" disabled>
              Choose a category…
            </option>
            {groups.map((g, i) =>
              g.group === null ? (
                // Standalone column (Refunds) — no group heading in the
                // workbook either, so none here.
                g.items.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))
              ) : (
                <optgroup key={`${g.group}-${i}`} label={g.group}>
                  {g.items.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              )
            )}
          </select>
          {/* ONE row is ONE category. Says so here because the workbook row it
              replaces had thirteen amount cells and people will look for them. */}
          <span className={HINT_CLS}>
            {hourly
              ? "Billed by the hour. Enter hours below — the dollar cost is worked out from the current rate when you save."
              : "One category per entry. An invoice that splits across two categories is submitted twice — both entries get the same PO number."}
          </span>
        </label>

        {/* METHOD IS UNMOUNTED ON THE HOURLY BRANCH, not disabled and not
            hidden. Josh: "if that is chosen, payment method should not be
            needed". The RPC nulls it anyway, so this is about not asking a
            question whose answer is discarded. */}
        {hourly ? null : (
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Method</span>
            <input
              type="text"
              name="method"
              list="expense-method-suggestions"
              placeholder="Company Card"
              autoComplete="off"
              className={INPUT_CLS}
            />
            <datalist id="expense-method-suggestions">
              {METHOD_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span className={HINT_CLS}>
              Suggestions only — type whatever the site actually calls it.
            </span>
          </label>
        )}

        <label
          className={`flex flex-col gap-1 ${hourly ? "sm:col-span-2 lg:col-span-3" : "sm:col-span-2"}`}
        >
          <span className={LABEL_CLS}>Description</span>
          <input
            type="text"
            name="description"
            placeholder={
              hourly ? "What was worked on, and by whom" : "Vendor and what was bought"
            }
            className={INPUT_CLS}
          />
          <span className={HINT_CLS}>
            Searchable from the filter bar above.
          </span>
        </label>

        {hourly ? (
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Hours billed to site *</span>
            <input
              type="number"
              name="labor_hours"
              required
              step="0.25"
              min="0.25"
              inputMode="decimal"
              placeholder="0.00"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className={INPUT_CLS}
            />
            {/* THE PREVIEW IS NOT THE STORED VALUE. Nothing here is posted —
                only the hours are. The database looks the rate up again and
                writes both the amount and the rate it used. */}
            {rate === null ? (
              <span className="text-[11px] font-semibold leading-snug text-splash-deny">
                No hourly rate has been set
                {businessDate ? ` as of ${businessDate}` : ""}, so this can&rsquo;t
                be saved yet. An administrator sets it under Labor rate.
              </span>
            ) : (
              <span className={HINT_CLS}>
                {preview === null ? (
                  <>Current rate: {money(rate)}/hr.</>
                ) : (
                  <>
                    <strong>≈ {money(preview)}</strong> at {money(rate)}/hr. The
                    exact amount is worked out when you save and files under
                    Repairs · Equipment Repair.
                  </>
                )}
              </span>
            )}
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Amount *</span>
            <input
              type="number"
              name="amount"
              required
              step="0.01"
              // NO `min`. Negative is a legitimate, expected value here — see the
              // hint. A min of 0 would make a returned pump impossible to record.
              inputMode="decimal"
              placeholder="0.00"
              className={INPUT_CLS}
            />
            <span className={HINT_CLS}>
              <strong>Refunds and credits are negative</strong> — type{" "}
              <span className="font-mono">-150.00</span> and file it under
              Refunds. Negative amounts net against the month.
            </span>
          </label>
        )}
      </div>

      <div className="mt-1">
        <SavingButton>Save expense</SavingButton>
      </div>
    </RedirectForm>
  );
}
