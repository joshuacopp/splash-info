"use client";

// Two ways to add: pick from what the chemical inventory already knows about
// this site, or type one in.
//
// BOTH ARE NEEDED, and the picker is deliberately not an auto-seed. Inventory
// tracks WASH chemicals only -- oil-lube products, cleaning supplies, peroxide
// and fuels are outside it entirely -- so it is a head start on the list and
// never the whole of it. And OSHA wants the identity here to match the identity
// on the actual sheet, which an internal product name may not; pre-filling rows
// that IMPLY somebody checked would be worse than starting empty.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { SdsCandidate } from "../_lib/types";
import { addChemicalAction, seedFromInventoryAction } from "../actions";
import CatalogSearch from "./CatalogSearch";

export default function AddChemical({
  locationCode,
  candidates
}: {
  locationCode: string;
  candidates: SdsCandidate[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "manual" | "inventory" | "catalog">(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode(null);
    setPicked(new Set());
    setError(null);
  }

  function addManual(formData: FormData) {
    const str = (k: string) => String(formData.get(k) ?? "").trim();
    setError(null);
    startTransition(async () => {
      const res = await addChemicalAction({
        location_code: locationCode,
        product_identifier: str("product_identifier"),
        manufacturer: str("manufacturer") || null,
        work_area: str("work_area") || null,
        binder_tab: str("binder_tab") || null
      });
      if (res.ok) {
        reset();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function addPicked() {
    setError(null);
    startTransition(async () => {
      const res = await seedFromInventoryAction(locationCode, [...picked]);
      if (res.ok) {
        reset();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (mode === null) {
    return (
      <div className="mt-4 flex flex-wrap gap-2">
        {/* First, because reusing an existing entry is the right answer far more
            often than typing a new one -- and it is the only one that brings a
            sheet with it. */}
        <button
          type="button"
          onClick={() => setMode("catalog")}
          className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5"
        >
          Find an existing chemical
        </button>
        <button
          type="button"
          onClick={() => setMode("manual")}
          className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5"
        >
          + Add a chemical
        </button>
        {candidates.length > 0 ? (
          <button
            type="button"
            onClick={() => setMode("inventory")}
            className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5"
          >
            Add from chemical inventory ({candidates.length})
          </button>
        ) : null}
      </div>
    );
  }

  if (mode === "catalog") {
    return <CatalogSearch locationCode={locationCode} onDone={reset} />;
  }

  if (mode === "inventory") {
    return (
      <div className="mt-4 rounded-splash-md border border-splash-navy/30 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
          Wash chemicals inventory has for this site
        </p>
        <p className="mt-1 mb-3 text-xs text-splash-navy/60">
          Tick the ones actually on site. Check each name against the safety data
          sheet — the list has to use the same identity the sheet does. Oil-lube,
          cleaning products and anything else not tracked in inventory must be
          added by hand.
        </p>
        <ul className="mb-3 max-h-64 space-y-1 overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.product_id}>
              <label className="flex items-center gap-2 text-sm text-splash-navy">
                <input
                  type="checkbox"
                  checked={picked.has(c.product_id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.product_id);
                    else next.delete(c.product_id);
                    setPicked(next);
                  }}
                />
                {c.product_name}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || picked.size === 0}
            onClick={addPicked}
            className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
          >
            {pending ? "Adding…" : `Add ${picked.size || ""} to the list`.trim()}
          </button>
          <button type="button" onClick={reset} className="text-xs text-splash-navy/60 underline">
            Cancel
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-racecar-red">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      action={addManual}
      className="mt-4 space-y-2 rounded-splash-md border border-splash-navy/30 bg-white p-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        Add a chemical
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-splash-navy/70">
          Tab
          <input
            name="binder_tab"
            className="block w-16 rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
          />
        </label>
        <label className="min-w-[16rem] flex-1 text-xs text-splash-navy/70">
          Product identifier
          <input
            name="product_identifier"
            required
            autoFocus
            placeholder="Exactly as printed on the SDS and the label"
            className="block w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
          />
        </label>
        <label className="min-w-[10rem] flex-1 text-xs text-splash-navy/70">
          Manufacturer
          <input
            name="manufacturer"
            className="block w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
          />
        </label>
        <label className="min-w-[10rem] flex-1 text-xs text-splash-navy/70">
          Where used / stored
          <input
            name="work_area"
            placeholder="Tunnel, oil lube bay, back room…"
            className="block w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add chemical"}
        </button>
        <button type="button" onClick={reset} className="text-xs text-splash-navy/60 underline">
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-racecar-red">
          {error}
        </p>
      ) : null}
    </form>
  );
}
