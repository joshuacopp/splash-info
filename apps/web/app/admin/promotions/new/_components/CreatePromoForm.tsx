// Brief 158b — client form for the create-promo screen.
//
// Wraps the createPromoAction server action in <ActionForm>. The action
// returns ActionResult; on success it carries the new promoId in `message`
// (encoded as a sentinel "OK:{id}" that this client component parses to
// trigger a router.push). Avoids overhauling <ActionForm>'s onResult
// signature for a single redirect-on-success flow.

"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionForm } from "../../../_components/ActionForm";
import type { ActionResult } from "../../../_components/ActionForm";
import { createPromoAction } from "../../_actions/createActions";
import type { PromoLocationOption } from "../../_lib/worker-fetch";

const PROMO_TYPES = ["Same", "BOGO", "Add-ons", "Discount", "Other"] as const;
const PRIORITIES = ["High", "Medium", "Low"] as const;
const REQUIRES_POS_BEHAVIOR = new Set<string>(["BOGO", "Add-ons", "Discount"]);

interface Props {
  locations: PromoLocationOption[];
}

export default function CreatePromoForm({ locations }: Props) {
  const router = useRouter();
  const [promoType, setPromoType] = useState<string>("Same");
  const [selectedLocations, setSelectedLocations] = useState<Set<string>>(
    new Set()
  );
  const [locationFilter, setLocationFilter] = useState("");
  const hiddenLocationsRef = useRef<HTMLInputElement>(null);

  const posBehaviorRequired = REQUIRES_POS_BEHAVIOR.has(promoType);
  const posBehaviorDisabled =
    promoType === "Same" || promoType === "Other";

  function toggleLocation(code: string) {
    setSelectedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      if (hiddenLocationsRef.current) {
        hiddenLocationsRef.current.value = Array.from(next).join(",");
      }
      return next;
    });
  }

  function selectAll() {
    const all = new Set(filtered.map((l) => l.locationCode));
    // include previously selected outside the current filter too
    selectedLocations.forEach((c) => all.add(c));
    setSelectedLocations(all);
    if (hiddenLocationsRef.current) {
      hiddenLocationsRef.current.value = Array.from(all).join(",");
    }
  }

  function clearAll() {
    setSelectedLocations(new Set());
    if (hiddenLocationsRef.current) hiddenLocationsRef.current.value = "";
  }

  const filtered =
    locationFilter.trim() === ""
      ? locations
      : locations.filter((l) => {
          const q = locationFilter.toLowerCase();
          return (
            l.locationCode.includes(q) ||
            l.locationPretty.toLowerCase().includes(q) ||
            (l.site ?? "").toLowerCase().includes(q)
          );
        });

  function handleResult(result: ActionResult) {
    if (
      result.ok &&
      result.data &&
      typeof result.data === "object" &&
      typeof (result.data as { promoId?: unknown }).promoId === "string"
    ) {
      const promoId = (result.data as { promoId: string }).promoId;
      // Replace so the back button doesn't bounce back to /new with stale form
      router.replace(`/admin/promotions/${promoId}`);
      router.refresh();
    }
  }

  return (
    <ActionForm
      action={createPromoAction}
      resetOnSuccess={false}
      onResult={handleResult}
      className="space-y-5"
    >
      <Field label="Promotion title" required>
        <input
          type="text"
          name="title"
          required
          maxLength={500}
          className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
          placeholder="e.g. May Family Plan BOGO"
        />
      </Field>

      <Field label="Locations affected" required>
        <input
          ref={hiddenLocationsRef}
          type="hidden"
          name="locationCodes"
          defaultValue=""
        />
        <div className="rounded-splash-sm border border-gray-light bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-light px-3 py-2">
            <input
              type="search"
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              placeholder="Filter by code, name, or site number…"
              className="min-w-[200px] flex-1 rounded-splash-sm border border-gray-light px-2 py-1 text-sm focus:border-splash-blue focus:outline-none"
            />
            <button
              type="button"
              onClick={selectAll}
              className="rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-xs font-semibold text-splash-navy hover:bg-gray-100"
            >
              Select all{locationFilter ? " filtered" : ""}
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-xs font-semibold text-splash-navy hover:bg-gray-100"
            >
              Clear
            </button>
            <span className="text-xs text-splash-navy/60">
              {selectedLocations.size} selected
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-sm italic text-splash-navy/60">
                No locations match.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((loc) => {
                  const checked = selectedLocations.has(loc.locationCode);
                  return (
                    <li key={loc.locationCode}>
                      <label
                        className={`flex cursor-pointer items-center gap-2 rounded-splash-sm border px-2 py-1.5 text-sm ${
                          checked
                            ? "border-splash-blue bg-splash-blue/5"
                            : "border-transparent hover:bg-gray-100"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLocation(loc.locationCode)}
                          className="h-4 w-4"
                        />
                        <span className="flex-1 truncate">
                          <span className="font-medium text-splash-navy">
                            {loc.locationPretty}
                          </span>
                          {loc.site && (
                            <span className="ml-1 text-splash-navy/55">
                              ({loc.site})
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </Field>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Proposed start date" required>
          <input
            type="date"
            name="proposedStartDate"
            required
            className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
          />
        </Field>
        <Field label="Proposed end date" required>
          <input
            type="date"
            name="proposedEndDate"
            required
            className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Promo type" required>
          <select
            name="promoType"
            value={promoType}
            onChange={(e) => setPromoType(e.target.value)}
            required
            className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
          >
            {PROMO_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" required>
          <select
            name="priority"
            required
            defaultValue="Medium"
            className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Kiosk / POS behavior"
        required={posBehaviorRequired}
        hint={
          posBehaviorDisabled
            ? `Not required for ${promoType} promotions.`
            : "Describe what should happen at the kiosk / POS."
        }
      >
        <textarea
          name="posBehavior"
          rows={3}
          disabled={posBehaviorDisabled}
          className={`w-full rounded-splash-sm border bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none ${
            posBehaviorDisabled
              ? "cursor-not-allowed border-gray-light/60 bg-gray-100 text-splash-navy/40"
              : "border-gray-light"
          }`}
          placeholder={
            posBehaviorDisabled
              ? "—"
              : "e.g. POS shows BOGO line item at checkout"
          }
        />
      </Field>

      <Field label="Requested go-live date" required>
        <input
          type="date"
          name="requestedGoLiveDate"
          required
          className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none sm:max-w-[260px]"
        />
      </Field>

      <div className="flex items-center justify-end gap-3 border-t border-gray-light pt-4">
        <Link
          href="/admin/promotions"
          className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy hover:bg-gray-100"
        >
          Cancel
        </Link>
        <button
          type="submit"
          className="rounded-splash-sm bg-splash-blue px-5 py-2 text-sm font-bold text-white shadow-splash-card hover:opacity-95"
        >
          Submit promotion
        </button>
      </div>
    </ActionForm>
  );
}

function Field({
  label,
  required,
  hint,
  children
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {label}
        {required && <span className="ml-1 text-splash-deny">*</span>}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-xs text-splash-navy/55">{hint}</p>
      )}
    </div>
  );
}
