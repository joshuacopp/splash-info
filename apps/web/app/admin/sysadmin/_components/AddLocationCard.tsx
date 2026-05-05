// AddLocationCard — client island on /admin/sysadmin. Brief 24.
//
// Posts to POST /sysadmin/api/pricing-simple/create-location via
// createLocationAction (server action). Renders one form with two sections:
//
//   1. Location-level fields (location_pretty, location_code, site, AM/RM
//      names, three optional emails).
//   2. Package picker — 7 standard package rows (bubble_bath, ultra_bath,
//      bath, express, ext_exterior, extreme, works) with an include
//      checkbox + price columns. Default sort values from the spec are
//      pre-filled on rows 0-3.
//
// v1 trade: only the 7 standard package names are supported. Custom
// packages are deferred to a future Update Package brief or a one-shot
// SQL insert.
//
// Conditional `required` pattern (mirrors UploadDocumentCard from Brief
// 20): when a row's include checkbox is checked, its price inputs are
// `required`; otherwise they're loose. This prevents the UA from blocking
// submission on optional rows the operator chose to leave blank.

"use client";

import { useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import { createLocationAction } from "../actions";

interface PackageRowDefault {
  pkg: string;
  /** Default sort order — null means "leave blank". */
  defaultSort: number | null;
}

const PACKAGE_ROWS: PackageRowDefault[] = [
  { pkg: "bubble_bath", defaultSort: 1 },
  { pkg: "ultra_bath", defaultSort: 2 },
  { pkg: "bath", defaultSort: 3 },
  { pkg: "express", defaultSort: 4 },
  { pkg: "ext_exterior", defaultSort: null },
  { pkg: "extreme", defaultSort: null },
  { pkg: "works", defaultSort: null }
];

const labelCls =
  "mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const helperCls =
  "ml-2 normal-case tracking-normal text-[0.6875rem] font-normal text-splash-navy/50";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
const submitCls =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";

export function AddLocationCard() {
  // Track which rows are checked so the price inputs can flip `required`
  // on/off accordingly. Default-on for the four standard-priced rows.
  const [included, setIncluded] = useState<boolean[]>(() =>
    PACKAGE_ROWS.map((row) => row.defaultSort !== null)
  );

  return (
    <ActionForm action={createLocationAction} className="space-y-5">
      {/* Location-level fields ------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="add-loc-pretty" className={labelCls}>
            Location name
          </label>
          <input
            id="add-loc-pretty"
            name="location_pretty"
            type="text"
            required
            autoComplete="off"
            className={inputCls}
            placeholder="Binghamton"
          />
        </div>

        <div>
          <label htmlFor="add-loc-code" className={labelCls}>
            Location code
            <span className={helperCls}>lowercase + numbers + underscores</span>
          </label>
          <input
            id="add-loc-code"
            name="location_code"
            type="text"
            required
            autoComplete="off"
            pattern="[a-z0-9_]+"
            className={`${inputCls} font-mono`}
            placeholder="binghamton"
          />
        </div>

        <div>
          <label htmlFor="add-loc-site" className={labelCls}>
            Site number
            <span className={helperCls}>Optional</span>
          </label>
          <input
            id="add-loc-site"
            name="site"
            type="text"
            autoComplete="off"
            className={inputCls}
            placeholder="34"
          />
        </div>

        <div>
          <label htmlFor="add-loc-am" className={labelCls}>
            Area manager
            <span className={helperCls}>Optional</span>
          </label>
          <input
            id="add-loc-am"
            name="area_manager"
            type="text"
            autoComplete="off"
            className={inputCls}
            placeholder="Bill Trabulsy"
          />
        </div>

        <div>
          <label htmlFor="add-loc-rm" className={labelCls}>
            Regional manager
            <span className={helperCls}>Optional</span>
          </label>
          <input
            id="add-loc-rm"
            name="regional_manager"
            type="text"
            autoComplete="off"
            className={inputCls}
            placeholder="Jay Frank"
          />
        </div>

        <div>
          <label htmlFor="add-loc-site-email" className={labelCls}>
            Site email
            <span className={helperCls}>Optional</span>
          </label>
          <input
            id="add-loc-site-email"
            name="site_email"
            type="email"
            autoComplete="off"
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="add-loc-am-email" className={labelCls}>
            AM email
            <span className={helperCls}>Optional</span>
          </label>
          <input
            id="add-loc-am-email"
            name="am_email"
            type="email"
            autoComplete="off"
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="add-loc-rm-email" className={labelCls}>
            RM email
            <span className={helperCls}>Optional</span>
          </label>
          <input
            id="add-loc-rm-email"
            name="rm_email"
            type="email"
            autoComplete="off"
            className={inputCls}
          />
        </div>
      </div>

      {/* Packages section ----------------------------------------- */}
      <fieldset className="rounded-splash-sm border border-gray-light bg-gray-light/20 p-4">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
          Packages
        </legend>
        <p className="mb-3 text-[0.6875rem] text-splash-navy/60">
          Toggle each package row to include it. Only the 7 standard packages
          are listed; custom packages can be added later via SQL or a future
          Update Package screen. New locations always default to{" "}
          <code className="rounded bg-white/70 px-1 py-0.5 font-mono">pricing = 'full'</code>
          .
        </p>

        <div className="hidden md:grid md:grid-cols-[2rem_minmax(0,1.5fr)_repeat(4,minmax(0,1fr))_5rem] md:gap-2 md:px-2 md:pb-1 md:text-[0.6875rem] md:font-semibold md:uppercase md:tracking-wider md:text-splash-navy/60">
          <span aria-hidden="true" />
          <span>Package</span>
          <span>pkg$</span>
          <span>single</span>
          <span>flash2</span>
          <span>flash5</span>
          <span>sort</span>
        </div>

        <div className="space-y-2">
          {PACKAGE_ROWS.map((row, i) => {
            const isIncluded = included[i] ?? false;
            return (
              <div
                key={row.pkg}
                className="grid grid-cols-1 gap-2 rounded-splash-sm border border-transparent bg-white/60 p-2 md:grid-cols-[2rem_minmax(0,1.5fr)_repeat(4,minmax(0,1fr))_5rem] md:items-center md:gap-2 md:bg-transparent"
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name={`pkg_${i}_include`}
                    checked={isIncluded}
                    onChange={(e) => {
                      const next = [...included];
                      next[i] = e.target.checked;
                      setIncluded(next);
                    }}
                    className="h-4 w-4 cursor-pointer accent-splash-blue"
                  />
                  <span className="md:hidden text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                    Include
                  </span>
                </label>

                <div className="font-mono text-sm text-splash-navy">
                  <input type="hidden" name={`pkg_${i}_pkg`} value={row.pkg} />
                  {row.pkg}
                </div>

                <input
                  type="number"
                  name={`pkg_${i}_pkg_dollar`}
                  min="0"
                  step="0.01"
                  required={isIncluded}
                  disabled={!isIncluded}
                  className={inputCls}
                  placeholder="0.00"
                  aria-label={`${row.pkg} pkg$`}
                />

                <input
                  type="number"
                  name={`pkg_${i}_single`}
                  min="0"
                  step="0.01"
                  required={isIncluded}
                  disabled={!isIncluded}
                  className={inputCls}
                  placeholder="0.00"
                  aria-label={`${row.pkg} single`}
                />

                <input
                  type="number"
                  name={`pkg_${i}_flash2`}
                  min="0"
                  step="0.01"
                  required={isIncluded}
                  disabled={!isIncluded}
                  defaultValue="2.00"
                  className={inputCls}
                  aria-label={`${row.pkg} flash2`}
                />

                <input
                  type="number"
                  name={`pkg_${i}_flash5`}
                  min="0"
                  step="0.01"
                  required={isIncluded}
                  disabled={!isIncluded}
                  defaultValue="5.00"
                  className={inputCls}
                  aria-label={`${row.pkg} flash5`}
                />

                <input
                  type="number"
                  name={`pkg_${i}_sort`}
                  min="1"
                  step="1"
                  disabled={!isIncluded}
                  defaultValue={row.defaultSort ?? ""}
                  className={inputCls}
                  placeholder="—"
                  aria-label={`${row.pkg} sort`}
                />
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="pt-1">
        <button type="submit" className={submitCls}>
          Create location
        </button>
      </div>
    </ActionForm>
  );
}
