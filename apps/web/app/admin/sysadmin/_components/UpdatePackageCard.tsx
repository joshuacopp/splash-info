// UpdatePackageCard — "Update package pricing" client island on
// /admin/sysadmin. Brief 36 (replaces Brief 26's per-row search-then-edit).
//
// Flow:
//   1. Pick a location via the typeahead (PackageSearchPicker, dedupes
//      pricing_simple search results into one option per location_code).
//   2. On selection, fetch all packages at that location via the same
//      /sysadmin/api/pricing-simple/search endpoint with q=<location_code>.
//      Render rows with a "select all" header checkbox + per-row checkboxes.
//   3. Checking a row reveals number inputs pre-filled with the row's
//      current pkg$ / single / sort. Operator types new values; unchanged
//      cells just submit the current value (a no-op patch for that field).
//   4. Submit fires updatePackagesBulkAction → PATCH
//      /sysadmin/api/pricing-simple/packages-bulk. Success message shows
//      worker's per-row results ("12 packages updated, 0 failed").
//
// Scope is intentionally pricing-only (pkg$/single/sort). Rename,
// pricing-mode, flash2/flash5, and location_pretty stay on the deprecated
// single-row Brief 26 endpoint — see brief-036 §C.2 step 3.
//
// Worker hard-caps the bulk request at 20 entries (matching apps/web's
// BULK_PACKAGES_MAX_SELECTED in actions.ts). The card surfaces a hint
// once the 20-row threshold is hit; the submit button stays disabled
// until the operator deselects rows.

"use client";

import { useEffect, useState } from "react";
import { ActionForm, type ActionResult } from "../../_components/ActionForm";
import { updatePackagesBulkAction } from "../actions";
import {
  PackageSearchPicker,
  type BulkLocationOption,
  type PricingSimpleSearchRow
} from "./PackageSearchPicker";

const labelCls =
  "mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
const submitCls =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:bg-splash-navy/30";
const cancelLinkCls =
  "text-sm font-semibold text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline";

const MAX_SELECTED = 20;

function formatMoney(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}

function valueOrEmpty(v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function UpdatePackageCard() {
  const [location, setLocation] = useState<BulkLocationOption | null>(null);
  const [rows, setRows] = useState<PricingSimpleSearchRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch packages for the chosen location whenever the picker changes.
  // Reuses the existing pricing-simple/search endpoint with the bare
  // location_code as q — Brief 26's ilike substring matches the code
  // exactly, so the response contains every package at that location.
  useEffect(() => {
    let cancelled = false;
    if (!location) {
      setRows([]);
      setSelected(new Set());
      setLoadError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError(null);
    const code = location.location_code;
    void (async () => {
      try {
        const url = `/sysadmin/api/pricing-simple/search?q=${encodeURIComponent(code)}`;
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });
        if (cancelled) return;
        if (!resp.ok) {
          setLoadError(`Could not load packages (${resp.status}).`);
          setRows([]);
          return;
        }
        const data = (await resp.json()) as PricingSimpleSearchRow[];
        if (cancelled) return;
        // The search may match other rows by substring (e.g. typing
        // "bath" returns rows from many locations). Filter strictly to
        // the chosen location_code so the multi-select grid only shows
        // packages at that location.
        const filtered = data
          .filter((r) => r.location_code === code)
          .sort((a, b) => {
            const sa = a.sort ?? Number.MAX_SAFE_INTEGER;
            const sb = b.sort ?? Number.MAX_SAFE_INTEGER;
            if (sa !== sb) return sa - sb;
            return a.pkg.localeCompare(b.pkg);
          });
        setRows(filtered);
        setSelected(new Set());
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not load packages.");
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [location]);

  function toggleRow(pkg: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pkg)) {
        next.delete(pkg);
      } else {
        next.add(pkg);
      }
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(rows.map((r) => r.pkg)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  function onResult(result: ActionResult) {
    if (result.ok) {
      // Re-fetch the location's packages after a successful save so the
      // grid shows the newly-persisted values. Trigger by toggling
      // location identity.
      const current = location;
      if (current) {
        setLocation({ ...current });
      }
    }
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const overLimit = selected.size > MAX_SELECTED;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="bulk-pkg-search" className={labelCls}>
          Find a location
        </label>
        <PackageSearchPicker
          inputId="bulk-pkg-search"
          selected={location}
          onSelect={(row) => {
            setLocation(row);
          }}
        />
      </div>

      {!location ? (
        <p className="text-sm italic text-splash-navy/60">
          Pick a location above to see its packages.
        </p>
      ) : loading ? (
        <p className="text-sm italic text-splash-navy/60">Loading packages…</p>
      ) : loadError ? (
        <p className="rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny">
          {loadError}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-splash-navy/60">
          No packages found at this location.
        </p>
      ) : (
        <ActionForm
          key={location.location_code}
          action={updatePackagesBulkAction}
          onResult={onResult}
          resetOnSuccess={false}
          className="space-y-4"
        >
          <input type="hidden" name="location_code" value={location.location_code} />

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-splash-navy/70">
            <div>
              {selected.size} of {rows.length} selected
              {overLimit ? (
                <span className="ml-2 font-semibold text-splash-deny">
                  · max {MAX_SELECTED} per save
                </span>
              ) : null}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={allSelected ? selectNone : selectAll}
                className={cancelLinkCls}
              >
                {allSelected ? "Select none" : "Select all"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-splash-sm border border-gray-light">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-light/40 text-[10px] uppercase tracking-wider text-splash-navy/70">
                <tr>
                  <th scope="col" className="w-10 px-2 py-2 text-left">
                    <input
                      type="checkbox"
                      aria-label="Select all packages"
                      checked={allSelected}
                      onChange={(e) => (e.target.checked ? selectAll() : selectNone())}
                    />
                  </th>
                  <th scope="col" className="px-2 py-2 text-left">pkg</th>
                  <th scope="col" className="px-2 py-2 text-left">pkg$</th>
                  <th scope="col" className="px-2 py-2 text-left">single</th>
                  <th scope="col" className="px-2 py-2 text-left">sort</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const isSelected = selected.has(row.pkg);
                  const rowCls = isSelected
                    ? "bg-sudsy-blue-soft/30"
                    : idx % 2 === 0
                      ? "bg-white"
                      : "bg-gray-light/15";
                  return (
                    <tr key={row.pkg} className={rowCls}>
                      <td className="px-2 py-2 align-top">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.pkg}`}
                          name={`bulk_pkg_${idx}_selected`}
                          value="on"
                          checked={isSelected}
                          onChange={() => toggleRow(row.pkg)}
                        />
                        {/* The pkg name travels via a hidden field bound
                            to the row index, so the action sees a stable
                            (selected, pkg, values) tuple even if the user
                            re-orders rows in a future revision. */}
                        <input
                          type="hidden"
                          name={`bulk_pkg_${idx}_pkg`}
                          value={row.pkg}
                        />
                      </td>
                      <td className="px-2 py-2 align-top font-mono text-splash-navy">
                        {row.pkg}
                      </td>
                      <td className="px-2 py-2 align-top">
                        {isSelected ? (
                          <input
                            type="number"
                            name={`bulk_pkg_${idx}_pkg_dollar`}
                            min="0"
                            step="0.01"
                            required
                            defaultValue={valueOrEmpty(row["pkg$"])}
                            className={`${inputCls} w-24`}
                          />
                        ) : (
                          <span className="text-splash-navy/80">
                            {formatMoney(row["pkg$"])}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 align-top">
                        {isSelected ? (
                          <input
                            type="number"
                            name={`bulk_pkg_${idx}_single`}
                            min="0"
                            step="0.01"
                            defaultValue={valueOrEmpty(row.single)}
                            placeholder="(blank → null)"
                            className={`${inputCls} w-24`}
                          />
                        ) : (
                          <span className="text-splash-navy/80">
                            {formatMoney(row.single)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 align-top">
                        {isSelected ? (
                          <input
                            type="number"
                            name={`bulk_pkg_${idx}_sort`}
                            min="1"
                            step="1"
                            defaultValue={valueOrEmpty(row.sort)}
                            placeholder="(blank → null)"
                            className={`${inputCls} w-20`}
                          />
                        ) : (
                          <span className="text-splash-navy/80">
                            {row.sort ?? "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-4 pt-1">
            <button
              type="submit"
              className={submitCls}
              disabled={selected.size === 0 || overLimit}
            >
              {selected.size > 0
                ? `Save ${selected.size} package${selected.size === 1 ? "" : "s"}`
                : "Save changes"}
            </button>
            <button
              type="button"
              onClick={() => setLocation(null)}
              className={cancelLinkCls}
            >
              Cancel / pick another location
            </button>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
