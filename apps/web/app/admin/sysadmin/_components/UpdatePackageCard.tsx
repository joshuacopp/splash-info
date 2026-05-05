// UpdatePackageCard — client island on /admin/sysadmin. Brief 26.
//
// Search-then-edit flow for one pricing_simple row identified by composite
// PK (location_code, pkg). Posts to PATCH /sysadmin/api/pricing-simple/package
// via updatePackageAction (server action).
//
// Layout:
//   1. PackageSearchPicker at top (typeahead).
//   2. Until a row is selected, the rest of the form is hidden.
//   3. On selection: form inflates with the row's current values pre-filled.
//      Editable: pkg$, single, flash2, flash5, sort, pkg (rename),
//      location_pretty, pricing (select).
//   4. Read-only context block below: denormalized fields (am/rm/site
//      email, area/regional_manager, site, address, updated_at). Note
//      explains these are managed via Update Location (Brief 27) — direct
//      edits here would be reverted by the trg_sync_pricing_simple
//      trigger.
//   5. Submit: "Save changes". Cancel link: clears picker + resets form.
//
// Conditional rendering pattern: the form is only mounted when `selected`
// is non-null. ActionForm's resetOnSuccess remounts the form on a fresh
// success but the editable inputs re-populate from defaultValue (the
// selected row's snapshot) — to avoid the operator seeing stale post-save
// values, the onResult callback clears the selection on success so the
// picker returns to its empty state. Operator picks the next package
// to edit.
//
// Hidden inputs that travel with the submit:
//   - location_code     (from selection — composite PK)
//   - pkg_original      (the pkg value at selection time — the worker
//                        looks up by this before applying any pkg rename)
// The editable `pkg` input maps to `pkg_new` in the action's payload.

"use client";

import { useState } from "react";
import { ActionForm, type ActionResult } from "../../_components/ActionForm";
import { updatePackageAction } from "../actions";
import {
  PackageSearchPicker,
  type PricingSimpleSearchRow
} from "./PackageSearchPicker";

const labelCls =
  "mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const helperCls =
  "ml-2 normal-case tracking-normal text-[0.6875rem] font-normal text-splash-navy/50";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
const submitCls =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";
const cancelLinkCls =
  "text-sm font-semibold text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline";

const PRICING_MODE_OPTIONS = ["full", "same", "flash5", "flash2", "special"] as const;

function valueOrEmpty(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function UpdatePackageCard() {
  const [selected, setSelected] = useState<PricingSimpleSearchRow | null>(null);

  function onResult(result: ActionResult) {
    if (result.ok) {
      setSelected(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="update-pkg-search" className={labelCls}>
          Find a package
          <span className={helperCls}>matches location_code, name, or site</span>
        </label>
        <PackageSearchPicker
          inputId="update-pkg-search"
          selected={selected}
          onSelect={setSelected}
        />
      </div>

      {selected ? (
        <ActionForm
          key={`${selected.location_code}/${selected.pkg}`}
          action={updatePackageAction}
          onResult={onResult}
          resetOnSuccess={false}
          className="space-y-5"
        >
          {/* Hidden composite-PK selectors -------------------------- */}
          <input
            type="hidden"
            name="location_code"
            value={selected.location_code}
          />
          <input type="hidden" name="pkg_original" value={selected.pkg} />

          {/* Editable fields --------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="update-pkg-pkg" className={labelCls}>
                Package name
                <span className={helperCls}>renames the row if changed</span>
              </label>
              <input
                id="update-pkg-pkg"
                name="pkg"
                type="text"
                required
                autoComplete="off"
                defaultValue={selected.pkg}
                className={`${inputCls} font-mono`}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-pretty" className={labelCls}>
                Location name
                <span className={helperCls}>display name for this row</span>
              </label>
              <input
                id="update-pkg-pretty"
                name="location_pretty"
                type="text"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.location_pretty)}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-pkgdollar" className={labelCls}>
                pkg$
                <span className={helperCls}>required</span>
              </label>
              <input
                id="update-pkg-pkgdollar"
                name="pkg_dollar"
                type="number"
                min="0"
                step="0.01"
                required
                defaultValue={valueOrEmpty(selected["pkg$"])}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-single" className={labelCls}>
                single
                <span className={helperCls}>blank → null</span>
              </label>
              <input
                id="update-pkg-single"
                name="single"
                type="number"
                min="0"
                step="0.01"
                defaultValue={valueOrEmpty(selected.single)}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-flash2" className={labelCls}>
                flash2
              </label>
              <input
                id="update-pkg-flash2"
                name="flash2"
                type="number"
                min="0"
                step="0.01"
                defaultValue={valueOrEmpty(selected.flash2)}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-flash5" className={labelCls}>
                flash5
              </label>
              <input
                id="update-pkg-flash5"
                name="flash5"
                type="number"
                min="0"
                step="0.01"
                defaultValue={valueOrEmpty(selected.flash5)}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-sort" className={labelCls}>
                sort
                <span className={helperCls}>positive int; blank → null</span>
              </label>
              <input
                id="update-pkg-sort"
                name="sort"
                type="number"
                min="1"
                step="1"
                defaultValue={valueOrEmpty(selected.sort)}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-pkg-pricing" className={labelCls}>
                pricing mode
                <span className={helperCls}>active mode for this row</span>
              </label>
              <select
                id="update-pkg-pricing"
                name="pricing"
                required
                defaultValue={selected.pricing ?? "full"}
                className={inputCls}
              >
                {PRICING_MODE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Read-only context block ------------------------------- */}
          <ReadOnlyContext row={selected} />

          {/* Actions ---------------------------------------------- */}
          <div className="flex items-center gap-4 pt-1">
            <button type="submit" className={submitCls}>
              Save changes
            </button>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className={cancelLinkCls}
            >
              Cancel / pick another
            </button>
          </div>
        </ActionForm>
      ) : (
        <p className="text-sm italic text-splash-navy/60">
          Pick a package above to edit its pricing fields.
        </p>
      )}
    </div>
  );
}

function ReadOnlyContext({ row }: { row: PricingSimpleSearchRow }) {
  return (
    <div className="rounded-splash-sm border border-gray-light bg-gray-light/30 p-4">
      <p className="mb-2 text-[0.6875rem] italic text-splash-navy/70">
        These fields are managed via Update Location (next card). Edits here
        would be reverted by the locations → pricing_simple sync trigger.
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs text-splash-navy md:grid-cols-2">
        <ReadOnlyField label="location_code" mono value={row.location_code} />
        <ReadOnlyField label="site" value={row.site} />
        <ReadOnlyField label="area_manager" value={row.area_manager} />
        <ReadOnlyField label="regional_manager" value={row.regional_manager} />
        <ReadOnlyField label="am_email" value={row.am_email} />
        <ReadOnlyField label="rm_email" value={row.rm_email} />
        <ReadOnlyField label="site_email" value={row.site_email} />
        <ReadOnlyField label="address" value={row.address} />
        <ReadOnlyField
          label="updated_at"
          mono
          value={row.updated_at ? row.updated_at.replace("T", " ").slice(0, 19) : null}
        />
      </dl>
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  mono
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 font-semibold uppercase tracking-wider text-splash-navy/60">
        {label}
      </dt>
      <dd className={`text-splash-navy/80 ${mono ? "font-mono" : ""}`}>
        {value && value.length > 0 ? value : <span className="text-splash-navy/40">—</span>}
      </dd>
    </div>
  );
}
