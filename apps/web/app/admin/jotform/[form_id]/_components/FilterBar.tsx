"use client";

// FilterBar (Brief 110) — three URL-driven dropdowns for the JotForm
// per-form submissions list. Sits above the existing DateRangePicker.
// Each dropdown change writes its key to the URL search params and
// navigates; the parent server component re-fetches with the narrowed
// scope. Worker re-validates on submit, so client-side cascade is purely
// a UX hint — clearing the URL by hand still works.
//
// Layout: flex row with three labeled <select>s; wraps on narrow screens.
// Empty-roster slots (e.g., a GM with only their site sees no RDs) are
// hidden entirely.

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import type {
  JotformRoster,
  RosterAm,
  RosterRm,
  RosterLocation
} from "../../_lib/worker-fetch";

interface Props {
  roster: JotformRoster;
}

export function FilterBar({ roster }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const amEmail = searchParams.get("am_email") ?? "";
  const rmEmail = searchParams.get("rm_email") ?? "";
  const locationCode = searchParams.get("location_code") ?? "";

  const selectedAm: RosterAm | undefined = useMemo(
    () => roster.regional_directors.find((e) => e.email === amEmail),
    [roster.regional_directors, amEmail]
  );
  const selectedRm: RosterRm | undefined = useMemo(
    () => roster.regional_managers.find((e) => e.email === rmEmail),
    [roster.regional_managers, rmEmail]
  );

  // Narrow RM options to those whose site_numbers intersect the
  // selected AM's coverage; same for Location.
  const rmOptions = useMemo<RosterRm[]>(() => {
    if (!selectedAm) return roster.regional_managers;
    const amSites = new Set(selectedAm.site_numbers);
    return roster.regional_managers.filter((rm) =>
      rm.site_numbers.some((s) => amSites.has(s))
    );
  }, [roster.regional_managers, selectedAm]);

  const locationOptions = useMemo<RosterLocation[]>(() => {
    let list = roster.locations;
    if (selectedAm) {
      const amSites = new Set(selectedAm.site_numbers);
      list = list.filter((loc) => amSites.has(loc.site_number));
    }
    if (selectedRm) {
      const rmSites = new Set(selectedRm.site_numbers);
      list = list.filter((loc) => rmSites.has(loc.site_number));
    }
    return list;
  }, [roster.locations, selectedAm, selectedRm]);

  function pushWith(key: "am_email" | "rm_email" | "location_code", value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Offset doesn't carry across filter changes — narrow filter sets
    // mean offset N might be past the new total.
    next.delete("offset");
    // When AM changes, also clear RM if RM no longer fits (UX).
    if (key === "am_email") {
      const selRm = roster.regional_managers.find((r) => r.email === rmEmail);
      if (selRm) {
        const newAm = roster.regional_directors.find((a) => a.email === value);
        if (newAm) {
          const amSet = new Set(newAm.site_numbers);
          const overlap = selRm.site_numbers.some((s) => amSet.has(s));
          if (!overlap) next.delete("rm_email");
        }
      }
      // Also clear location if it no longer fits.
      const selLoc = roster.locations.find((l) => l.location_code === locationCode);
      if (selLoc && value) {
        const newAm = roster.regional_directors.find((a) => a.email === value);
        if (newAm && !newAm.site_numbers.includes(selLoc.site_number)) {
          next.delete("location_code");
        }
      }
    }
    if (key === "rm_email") {
      const selLoc = roster.locations.find((l) => l.location_code === locationCode);
      if (selLoc && value) {
        const newRm = roster.regional_managers.find((r) => r.email === value);
        if (newRm && !newRm.site_numbers.includes(selLoc.site_number)) {
          next.delete("location_code");
        }
      }
    }
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?");
  }

  const showRdSlot = roster.regional_directors.length > 0;
  const showRmSlot = rmOptions.length > 0;
  const showLocationSlot = locationOptions.length > 0;

  if (!showRdSlot && !showRmSlot && !showLocationSlot) return null;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-splash-md border border-gray-light bg-white p-3">
      {showRdSlot && (
        <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
          Regional Director
          <select
            value={amEmail}
            onChange={(e) => pushWith("am_email", e.target.value)}
            className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          >
            <option value="">All Regional Directors</option>
            {roster.regional_directors.map((rd) => (
              <option key={rd.email} value={rd.email}>
                {rd.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {showRmSlot && (
        <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
          Regional Manager
          <select
            value={rmEmail}
            onChange={(e) => pushWith("rm_email", e.target.value)}
            className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          >
            <option value="">All Regional Managers</option>
            {rmOptions.map((rm) => (
              <option key={rm.email} value={rm.email}>
                {rm.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {showLocationSlot && (
        <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
          Location
          <select
            value={locationCode}
            onChange={(e) => pushWith("location_code", e.target.value)}
            className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          >
            <option value="">All Locations</option>
            {locationOptions.map((loc) => (
              <option key={loc.location_code || loc.site_number} value={loc.location_code}>
                {locationDisplayLabel(loc)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

// Brief 111 Phase 4: prefer `location_pretty` ("Binghamton"), fall back
// to `location_code` ("binghamton") — NOT the postal address. The roster
// worker (apps/jotform-worker/src/handlers/roster.js) falls back to
// `locations.location` (postal address) when `pricing_simple.location_pretty`
// is missing; this defensive client-side override detects the address
// shape (comma or leading digit) and surfaces `location_code` instead.
// Address is never the right surface for this dropdown.
function locationDisplayLabel(loc: RosterLocation): string {
  const pretty = (loc.location_pretty || "").trim();
  const code = (loc.location_code || "").trim();
  const site = (loc.site_number || "").trim();
  const looksLikeAddress = pretty.includes(",") || /^\d/.test(pretty);
  const label = !pretty || looksLikeAddress ? code || pretty || site : pretty;
  return site ? `${label} (${site})` : label;
}
