// Brief 158a — read-only per-location completion checklist.
//
// Renders "N of M complete" plus a checkbox-grid of every location on the
// promo. Each row shows the location_code + the completion checkbox state
// + the completion timestamp when set. Read-only at 158a — 158b wires the
// toggle action via the existing PATCH /promo/api/promos/{id}/locations/{code}
// endpoint (Brief 155).

import type { PromoLocation } from "../_lib/types";

interface Props {
  locations: PromoLocation[];
}

export function LocationProgress({ locations }: Props) {
  const total = locations.length;
  const done = locations.filter((l) => l.isComplete).length;

  if (total === 0) {
    return (
      <p className="text-sm italic text-splash-navy/60">
        No locations attached to this promo.
      </p>
    );
  }

  // Sort: incomplete first (alphabetical), then complete (alphabetical) so
  // the active work bubbles up.
  const sorted = [...locations].sort((a, b) => {
    if (a.isComplete !== b.isComplete) {
      return a.isComplete ? 1 : -1;
    }
    return a.locationCode.localeCompare(b.locationCode);
  });

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-2 text-sm">
        <span className="font-bold text-splash-navy">
          {done} of {total} complete
        </span>
        <span className="text-splash-navy/60">
          ({Math.round((done / total) * 100)}%)
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((loc) => (
          <li
            key={loc.locationCode}
            className={`flex items-center gap-2 rounded-splash-sm border px-3 py-1.5 text-sm ${
              loc.isComplete
                ? "border-emerald-200 bg-emerald-50/60 text-splash-navy"
                : "border-gray-light bg-white text-splash-navy"
            }`}
          >
            <span
              className={`inline-flex h-4 w-4 items-center justify-center rounded-sm border ${
                loc.isComplete
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-splash-navy/30 bg-white"
              }`}
              aria-hidden="true"
            >
              {loc.isComplete && (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={3.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3 w-3"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
            <span className="flex-1 truncate font-mono text-[0.8125rem]">
              {loc.locationCode}
            </span>
            {loc.isComplete && loc.completedAt && (
              <span
                className="text-[0.6875rem] text-emerald-700"
                title={loc.completedAt}
              >
                ✓
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default LocationProgress;
