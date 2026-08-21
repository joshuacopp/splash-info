// The entry form — one purchase, one category, one amount.
//
// A SERVER COMPONENT. Nothing here needs state: the category list is fetched by
// the page, the PO number is assigned by the database, and the only interactive
// piece is the LocationPicker (already a client component) and SavingButton
// (already a client component). Making this a client component to get a
// "preview your PO number" affordance was considered and rejected — see the
// hint copy below.
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

import type { ReactNode } from "react";
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
  returnQs,
  defaultDate,
  defaultLocationId,
  defaultLocationLabel,
  dateNote
}: {
  action: (formData: FormData) => Promise<RedirectResult>;
  categories: CategoryOption[];
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
            defaultValue={defaultDate}
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
            defaultValue=""
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
            One category per entry. An invoice that splits across two categories
            is submitted twice — both entries get the same PO number.
          </span>
        </label>

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

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>Description</span>
          <input
            type="text"
            name="description"
            placeholder="Vendor and what was bought"
            className={INPUT_CLS}
          />
          <span className={HINT_CLS}>
            Searchable from the filter bar above.
          </span>
        </label>

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
      </div>

      <div className="mt-1">
        <SavingButton>Save expense</SavingButton>
      </div>
    </RedirectForm>
  );
}
