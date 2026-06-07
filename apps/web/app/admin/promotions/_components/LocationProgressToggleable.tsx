// Brief 158b — toggleable per-location completion grid.
// Brief 164 — per-row notification indicator (amber clock = complete but
// un-notified; green check = notified). Reads `notifiedAt` off each row
// surfaced by the worker's detail endpoint.
//
// Drop-in companion to the read-only `<LocationProgress>` server
// component. Uses React 19's `useOptimistic` so the checkbox flips
// immediately on click; the server action runs in the background and
// reverts the optimistic state on failure.

"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PromoLocation } from "../_lib/types";
import { toggleLocationProgressAction } from "../_actions/ticketActions";

interface Props {
  promoId: string;
  locations: PromoLocation[];
}

export default function LocationProgressToggleable({
  promoId,
  locations
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [optimisticLocations, setOptimisticLocations] = useOptimistic(
    locations,
    (state, update: { locationCode: string; isComplete: boolean }) =>
      state.map((l) =>
        l.locationCode === update.locationCode
          ? { ...l, isComplete: update.isComplete }
          : l
      )
  );

  const total = optimisticLocations.length;
  const done = optimisticLocations.filter((l) => l.isComplete).length;

  function onToggle(locationCode: string, isComplete: boolean) {
    setError(null);
    startTransition(async () => {
      setOptimisticLocations({ locationCode, isComplete });
      const result = await toggleLocationProgressAction(
        promoId,
        locationCode,
        isComplete
      );
      if (!result.ok) {
        setError(`${locationCode}: ${result.error}`);
        // No need to manually revert — useOptimistic discards the override
        // when the transition ends, falling back to the server's `locations`
        // prop on the next router.refresh().
      }
      router.refresh();
    });
  }

  if (total === 0) {
    return (
      <p className="text-sm italic text-splash-navy/60">
        No locations attached to this promo.
      </p>
    );
  }

  const sorted = [...optimisticLocations].sort((a, b) => {
    if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
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
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny"
        >
          {error}
        </p>
      )}
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
            <input
              type="checkbox"
              checked={loc.isComplete}
              onChange={(e) => onToggle(loc.locationCode, e.target.checked)}
              className="h-4 w-4 cursor-pointer"
              aria-label={`Toggle ${loc.locationCode} complete`}
            />
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
            <NotificationIndicator
              isComplete={loc.isComplete}
              notifiedAt={loc.notifiedAt}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Brief 164 — per-row notification state hint.
 *   - not complete → no indicator (notification not yet possible).
 *   - complete + un-notified → amber clock icon ("pending notification").
 *   - complete + notified → green envelope icon w/ timestamp tooltip.
 */
function NotificationIndicator({
  isComplete,
  notifiedAt
}: {
  isComplete: boolean;
  notifiedAt: string | null;
}) {
  if (!isComplete) return null;
  if (notifiedAt === null) {
    return (
      <span
        title="Marked complete; site not yet notified"
        aria-label="Pending notification"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-[0.625rem] text-amber-700"
      >
        ⏱
      </span>
    );
  }
  return (
    <span
      title={`Notified ${notifiedAt}`}
      aria-label="Notified"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-[0.625rem] text-emerald-700"
    >
      ✉
    </span>
  );
}
