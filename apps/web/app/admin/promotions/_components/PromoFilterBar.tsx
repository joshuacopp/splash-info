"use client";

// Brief 158a — URL-driven filter bar for the promotions dashboard +
// IT queue pages.
//
// Pattern mirrors `apps/web/app/_components/DateRangePicker.tsx` (Brief 83):
// inputs feed into a single Apply button that pushes the resulting
// `?status=&priority=&assigned_to_me=&search=` URL search params; the
// server component re-reads the params and re-renders with filtered data.
//
// All controls are pure presentation. The brief defers fancier UX (e.g.,
// multi-select pill chips) to 158b's polish pass; the v1 controls are a
// single-status dropdown (the worker accepts comma-separated lists but
// we ship a single-select at v1 to keep the UI legible) + a priority
// dropdown + an "Assigned to me" checkbox + a search input.

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { PromoStatus, PromoPriority } from "../_lib/types";
import { PROMO_STATUSES, PROMO_PRIORITIES } from "../_lib/types";

interface Props {
  /** When true, the "Assigned to me" checkbox defaults checked when
   *  the URL param is absent (used on the IT queue page). */
  defaultAssignedToMe?: boolean;
}

export function PromoFilterBar({ defaultAssignedToMe = false }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialStatus = searchParams.get("status") ?? "";
  const initialPriority = searchParams.get("priority") ?? "";
  const initialAssigned =
    searchParams.get("assigned_to_me") === "1" ||
    (defaultAssignedToMe && !searchParams.has("assigned_to_me"));
  const initialSearch = searchParams.get("search") ?? "";

  const [status, setStatus] = useState<string>(initialStatus);
  const [priority, setPriority] = useState<string>(initialPriority);
  const [assigned, setAssigned] = useState<boolean>(initialAssigned);
  const [search, setSearch] = useState<string>(initialSearch);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    if (priority) next.set("priority", priority);
    if (assigned) next.set("assigned_to_me", "1");
    if (search) next.set("search", search);
    // offset always resets on filter change.
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?");
  };

  const reset = () => {
    setStatus("");
    setPriority("");
    setAssigned(defaultAssignedToMe);
    setSearch("");
    const next = new URLSearchParams();
    if (defaultAssignedToMe) next.set("assigned_to_me", "1");
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?");
  };

  return (
    <form
      onSubmit={apply}
      className="mb-5 flex flex-wrap items-end gap-3 rounded-splash-md border border-gray-light bg-white p-3"
    >
      <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
        Status
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
        >
          <option value="">All</option>
          {PROMO_STATUSES.map((s: PromoStatus) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
        Priority
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
        >
          <option value="">All</option>
          {PROMO_PRIORITIES.map((p: PromoPriority) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
        Search
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Title substring"
          className="mt-1 w-56 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
        />
      </label>
      <label className="mb-1 inline-flex items-center gap-2 text-sm font-semibold text-splash-navy">
        <input
          type="checkbox"
          checked={assigned}
          onChange={(e) => setAssigned(e.target.checked)}
          className="h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
        />
        Assigned to me
      </label>
      <button
        type="submit"
        className="inline-flex items-center rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
      >
        Apply
      </button>
      {(status || priority || assigned !== defaultAssignedToMe || search) && (
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
        >
          Reset
        </button>
      )}
    </form>
  );
}

export default PromoFilterBar;
